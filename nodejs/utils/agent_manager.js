'use strict';

const crypto = require('crypto');
const agentKeys = require('./agent_keys');
const { Agent } = require('../models/agent');

// Tracks the live WebSocket for each enrolled agent and brokers commands to it.
//
// The durable facts about an agent (identity, host binding, last seen, last
// discovery/telemetry) live in the Agent table; this class holds only what
// cannot be persisted -- the open socket. That split is what makes an installed
// -but-offline agent visible, and what stops a restart from erasing the fleet.
class AgentManager {
  constructor() {
    // agentId -> { ws, ipAddress, connectedAt, lastResponse, pending }
    this.live = new Map();
  }

  /**
   * Canonicalize payload for signing per PROTOCOL.md v1.1.0 section 5:
   * Sort keys alphabetically, remove whitespace, omit 'signature' key.
   */
  canonicalize(payload) {
    const sortObj = (val) => {
      if (val === null || typeof val !== 'object') return val;
      if (Array.isArray(val)) return val.map(sortObj);
      const sorted = {};
      const keys = Object.keys(val).filter(k => k !== 'signature').sort();
      for (const k of keys) {
        sorted[k] = sortObj(val[k]);
      }
      return sorted;
    };
    return JSON.stringify(sortObj(payload));
  }

  /**
   * Sign payload using the persisted Ed25519 private key. Throws when no key is
   * available rather than minting a throwaway one -- an agent verifies against
   * the key pinned in its agent.yml, so a signature from a key it has never
   * seen is not a weaker signature, it is a broken command that looks fine from
   * this side.
   */
  async signPayload(payload) {
    const keys = await agentKeys.load();
    if (!keys) {
      const { error } = agentKeys.status();
      throw new Error(`agent command signing is unavailable: ${error || 'no signing key'}`);
    }
    const canonicalBytes = Buffer.from(this.canonicalize(payload), 'utf8');
    return crypto.sign(null, canonicalBytes, keys.privateKeyPem).toString('base64');
  }

  async publicKeyBase64() {
    const keys = await agentKeys.load();
    return keys ? keys.publicKeyBase64 : null;
  }

  async publicKeyPem() {
    const keys = await agentKeys.load();
    return keys ? keys.publicKeyPem : null;
  }

  // Bind a freshly authenticated socket to an enrolled agent. `agent` is an
  // Agent row that Agent.authenticate() has already vouched for -- this method
  // never sees a raw token and must never be called with an unauthenticated one.
  // Synchronous by design. The caller must attach its `message` listener in the
  // same tick as the connection is accepted: `ws` drops events emitted before a
  // listener exists, and the agent sends `discovery` immediately on open, so
  // awaiting a database round-trip here silently lost every agent's first
  // discovery frame. The connect timestamp is persisted in the background.
  registerAgent(agent, ws, remoteAddress) {
    const existing = this.live.get(agent.id);
    if (existing && existing.ws && existing.ws !== ws) {
      try { existing.ws.close(4002, 'Superseded by new connection'); } catch (e) {}
    }

    this.live.set(agent.id, {
      ws,
      ipAddress: remoteAddress,
      connectedAt: new Date().toISOString(),
      lastResponse: null
    });

    agent.update({
      last_seen: Math.floor(Date.now() / 1000),
      last_ip: remoteAddress || null
    }).catch(err => console.error(`[AgentManager] could not record connect for ${agent.id}:`, err.message));
  }

  unregisterAgent(agentId, ws) {
    const state = this.live.get(agentId);
    if (state && state.ws === ws) this.live.delete(agentId);
  }

  // Drop an agent's live socket now. Revocation that only takes effect on the
  // next reconnect is not revocation -- a connected agent would keep receiving
  // commands indefinitely.
  disconnect(agentId, code = 4003, reason = 'Disconnected by server') {
    const state = this.live.get(agentId);
    if (!state || !state.ws) return false;
    try { state.ws.close(code, reason); } catch (e) {}
    this.live.delete(agentId);
    return true;
  }

  isConnected(agentId) {
    const state = this.live.get(agentId);
    return !!(state && state.ws && state.ws.readyState === 1);
  }

  async touch(agent, extra = {}) {
    await agent.update({
      last_seen: Math.floor(Date.now() / 1000),
      ...extra
    }).catch(err => console.error(`[AgentManager] could not persist agent ${agent.id}:`, err.message));
  }

  async handleDiscovery(agent, payload) {
    const discovery = {
      hostname: payload.hostname || '',
      ip_addresses: Array.isArray(payload.ip_addresses) ? payload.ip_addresses : [],
      os: payload.os || '',
      kernel: payload.kernel || '',
      cpu: payload.cpu || '',
      ram_total_gb: payload.ram_total_gb || 0,
      disk_total_gb: payload.disk_total_gb || 0,
      location: payload.location || 'default',
      // The agent's enabled capabilities (from its local agent.yml). The agent
      // is the authoritative source for what it will actually do.
      capabilities: payload.capabilities || {}
    };
    await this.touch(agent, { lastDiscovery: discovery });
    await this.applyDiscoveryToDirectory(agent, discovery);
  }

  // An agent runs ON the host it describes, which makes it the most
  // authoritative source the directory has -- more so than a hypervisor API or
  // a network scan. It previously updated nothing at all: the facts sat on an
  // in-memory record and were lost on disconnect.
  //
  // When the agent is bound to a resource we write that row directly; guessing
  // is only for an unbound agent, and then we let the shared reconciler do the
  // matching (same MAC/IP/name rules every other source goes through) rather
  // than inventing a second matcher here.
  async applyDiscoveryToDirectory(agent, discovery) {
    try {
      const { Resource } = require('../models/resource');
      const metadata = {
        os: discovery.os || undefined,
        kernel: discovery.kernel || undefined,
        cpu: discovery.cpu || undefined,
        ram_total_gb: discovery.ram_total_gb || undefined,
        disk_total_gb: discovery.disk_total_gb || undefined,
        ip: (discovery.ip_addresses || [])[0] || undefined,
        public_ip: discovery.public_ip || undefined,
        agentId: agent.id,
        last_seen: Date.now()
      };
      // Drop undefined so a field the agent could not determine never
      // overwrites a good value already in the directory.
      for (const k of Object.keys(metadata)) if (metadata[k] === undefined) delete metadata[k];

      if (agent.resourceId) {
        const resource = await Resource.get(agent.resourceId);
        if (!resource) return;
        const merged = { ...(resource.metadata || {}), ...metadata };
        const sources = new Set(merged.discovery_sources || []);
        sources.add('theta-agent');
        merged.discovery_sources = [...sources];
        await resource.update({ metadata: merged, updated_on: Math.floor(Date.now() / 1000) });
        return;
      }

      if (!discovery.hostname) return;
      const { DiscoveryReconciler } = require('../services/discovery_reconciler');
      const { ResourceEdge } = require('../models/resource');

      const hostSlug = `host-${discovery.hostname.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;
      await DiscoveryReconciler.reconcile('theta-agent', {
        resources: [{
          kind: 'host',
          name: discovery.hostname,
          slug: hostSlug,
          metadata: { ...metadata, subType: 'linux', managed: true }
        }],
        edges: []
      });

      // Find the matched or created host resource
      const allHosts = await Resource.list({ where: { kind: 'host' } });
      const hostRes = allHosts.find(r => 
        r.name.toLowerCase() === discovery.hostname.toLowerCase() || 
        r.slug === hostSlug || 
        r.metadata?.agentId === agent.id
      );

      if (hostRes) {
        // Bind the agent to its Host resource
        await agent.update({ resourceId: hostRes.id }).catch(() => {});

        // Attach host to matching Site by Public IP if not already parented
        const existingEdges = await ResourceEdge.list({ where: { childId: hostRes.id } });
        if (existingEdges.length === 0) {
          const sites = await Resource.list({ where: { kind: 'site' } });
          let targetSite = null;
          if (discovery.public_ip) {
            targetSite = sites.find(s => {
              const siteIp = (s.metadata?.public_ip || s.metadata?.ip || s.metadata?.address || '').trim();
              return siteIp && (siteIp === discovery.public_ip || siteIp.includes(discovery.public_ip));
            });
          }
          if (!targetSite) targetSite = sites[0];

          if (targetSite) {
            await ResourceEdge.create({
              id: crypto.randomUUID(),
              parentId: targetSite.id,
              childId: hostRes.id,
              relation: 'hosts'
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      // Never let a directory write break the agent connection.
      console.error(`[AgentManager] discovery -> directory failed for agent ${agent.id}:`, err.message);
    }
  }

  async handleTelemetry(agent, payload) {
    await this.touch(agent, {
      lastTelemetry: {
        cpu_usage_percent: payload.cpu_usage_percent || 0,
        ram_usage_percent: payload.ram_usage_percent || 0,
        disk_usage_percent: payload.disk_usage_percent || 0,
        zfs_health: payload.zfs_health || 'N/A',
        gpu_usage_percent: payload.gpu_usage_percent ?? -1,
        timestamp: payload.timestamp || new Date().toISOString()
      }
    });
  }

  async handleHeartbeat(agent, payload, ws) {
    await this.touch(agent);
    try {
      ws.send(JSON.stringify({
        type: 'heartbeat_ack',
        payload: { timestamp: new Date().toISOString() }
      }));
    } catch (e) {}
  }

  async handleResponse(agent, payload) {
    const state = this.live.get(agent.id);
    if (state) {
      state.lastResponse = {
        status: payload.status || 'ok',
        message: payload.message || '',
        output: payload.output || '',
        timestamp: new Date().toISOString()
      };
    }
    await this.touch(agent);
  }

  async sendCommand(agent, commandType, payload = {}, isHighRisk = false) {
    const state = this.live.get(agent.id);
    if (!state || !state.ws || state.ws.readyState !== 1) {
      throw new Error(`Agent "${agent.name}" is not connected`);
    }

    const finalPayload = { ...payload };
    if (isHighRisk) finalPayload.signature = await this.signPayload(finalPayload);

    const message = { type: commandType, payload: finalPayload };
    state.ws.send(JSON.stringify(message));
    return message;
  }

  // Live view for one agent, for merging into its row.
  liveState(agentId) {
    const state = this.live.get(agentId);
    if (!state) return { connected: false, lastResponse: null };
    return {
      connected: !!(state.ws && state.ws.readyState === 1),
      ipAddress: state.ipAddress,
      connectedAt: state.connectedAt,
      lastResponse: state.lastResponse || null
    };
  }

  // Find connected/enrolled agent bound to a resource ID.
  async getAgentForResource(resourceId) {
    if (!resourceId) return null;
    const rows = await Agent.list().catch(() => []);
    const agent = rows.find(a => a.resourceId === resourceId);
    if (!agent) return null;
    return agent.toPublic(this.liveState(agent.id));
  }

  // Every enrolled agent, connected or not.
  async listAgents() {
    const rows = await Agent.list();
    return rows.map(a => a.toPublic(this.liveState(a.id)));
  }
}

module.exports = new AgentManager();
module.exports.AgentManager = AgentManager;
