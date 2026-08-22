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

    // If on a spoke, push status update to master
    try {
      const siteConfig = require('./site_config');
      const cfg = siteConfig.get();
      if (!cfg.isMaster && cfg.masterUrl && (cfg.masterJoinKey || cfg.replicationPushToken)) {
        const now = Date.now();
        if (!this._lastPushMap) this._lastPushMap = new Map();
        const lastPush = this._lastPushMap.get(agent.id) || 0;
        if (extra.lastDiscovery || (now - lastPush > 30000)) {
          this._lastPushMap.set(agent.id, now);
          const { fetchWithAuthRedirect } = require('./fetch_with_auth_redirect');
          const targetUrl = String(cfg.masterUrl).replace(/\/+$/, '') + '/api/site/spokes/agent-report';
          fetchWithAuthRedirect(targetUrl, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + (cfg.replicationPushToken || cfg.masterJoinKey), 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agent: {
                id: agent.id,
                name: agent.name,
                description: agent.description,
                tokenHash: agent.tokenHash,
                tokenPrefix: agent.tokenPrefix,
                resourceId: agent.resourceId,
                revoked: agent.revoked,
                enrolled_by: agent.enrolled_by,
                enrolled_on: agent.enrolled_on,
                version: agent.version,
                last_seen: Math.floor(Date.now() / 1000),
                last_ip: agent.last_ip,
                lastDiscovery: agent.lastDiscovery,
                lastTelemetry: agent.lastTelemetry
              },
              discovery: extra.lastDiscovery,
              telemetry: extra.lastTelemetry
            })
          }, { timeoutMs: 10000 }).catch(() => {});
        }
      }
    } catch (e) {
      // Best-effort
    }
  }

  async handleDiscovery(agent, payload) {
    const discovery = {
      version: payload.version || payload.agent_version || 'unknown',
      hostname: payload.hostname || '',
      ip_addresses: Array.isArray(payload.ip_addresses) ? payload.ip_addresses : [],
      public_ip: payload.public_ip || '',
      os: payload.os || '',
      kernel: payload.kernel || '',
      cpu: payload.cpu || '',
      cpu_details: payload.cpu_details || {},
      ram_total_gb: payload.ram_total_gb || 0,
      ram_details: payload.ram_details || {},
      disk_total_gb: payload.disk_total_gb || 0,
      disks: Array.isArray(payload.disks) ? payload.disks : [],
      logged_users: Array.isArray(payload.logged_users) ? payload.logged_users : [],
      host_details: payload.host_details || {},
      location: payload.location || 'default',
      // The agent's enabled capabilities (from its local agent.yml). The agent
      // is the authoritative source for what it will actually do.
      capabilities: payload.capabilities || {}
    };
    await this.touch(agent, { version: discovery.version, lastDiscovery: discovery });
    await this.applyDiscoveryToDirectory(agent, discovery);
  }

  async handleTelemetry(agent, payload) {
    const stored = {
      cpu_usage_percent: payload.cpu_usage_percent || 0,
      cpu_details: payload.cpu_details || {},
      ram_usage_percent: payload.ram_usage_percent || 0,
      ram_details: payload.ram_details || {},
      disk_usage_percent: payload.disk_usage_percent || 0,
      disks: Array.isArray(payload.disks) ? payload.disks : [],
      logged_users: Array.isArray(payload.logged_users) ? payload.logged_users : [],
      host_details: payload.host_details || {},
      zfs_health: payload.zfs_health || 'N/A',
      gpu_usage_percent: payload.gpu_usage_percent ?? -1,
      timestamp: payload.timestamp || new Date().toISOString()
    };
    // Registered systemd services and their live status, so the driver can
    // surface per-service health from telemetry alone.
    if (Array.isArray(payload.services)) {
      stored.services = payload.services;
    }
    await this.touch(agent, { lastTelemetry: stored });

    // The telemetry stream is a second, softer reconciliation pass: if a
    // register_service frame was ever lost, the periodic telemetry keeps the
    // directory's service children in sync with the agent's `services:` list.
    if (Array.isArray(payload.services) && payload.services.length > 0) {
      await this.reconcileServicesFromTelemetry(agent, payload.services).catch(err =>
        console.error(`[AgentManager] telemetry service reconcile failed for ${agent.id}:`, err.message)
      );
    }
  }

  // Ensure a `service` resource exists in the directory for each registered
  // service (systemd unit or docker container), parented under this agent's
  // host. Idempotent and safe to run on every telemetry tick -- it matches by
  // (host, subtype, name) and only creates when missing.
  async reconcileServicesFromTelemetry(agent, services) {
    const { Resource, ResourceEdge } = require('../models/resource');

    // Resolve this agent's host resource (its own binding, or the host a
    // service inherits from).
    let hostRes = null;
    if (agent.resourceId) {
      hostRes = await Resource.get(agent.resourceId).catch(() => null);
    }
    if (!hostRes) {
      // Unbound agent: find the host that carries this agent's id in metadata.
      const hosts = await Resource.list({ where: { kind: 'host' } }).catch(() => []);
      hostRes = hosts.find(h => h.metadata && h.metadata.agentId === agent.id) || null;
    }
    if (!hostRes) {
      console.warn(`[AgentManager] cannot reconcile services for ${agent.id}: no bound host resource`);
      return;
    }

    for (const svc of services) {
      const name = (typeof svc === 'string') ? svc : (svc && svc.name);
      if (!name) continue;
      const subtype = (svc && (svc.subtype || svc.subType)) || 'systemd';
      const slug = `svc-${hostRes.slug.replace(/^host-/, '')}-${subtype}-${name.toLowerCase().replace(/[^a-z0-9_-]/g, '-')}`;

      // Match on subtype+name so units/containers/processes of the same name
      // don't collide. A generic `serviceName` field is authoritative; the
      // legacy `systemdService`/`dockerContainer` keys are also matched so
      // resources created before the generic field keep reconciling in place.
      let serviceRes = (await Resource.list({ where: { kind: 'service' } }).catch(() => []))
        .find(r => r.metadata && r.metadata.subType === subtype && r.metadata.hostId === hostRes.id &&
          (r.metadata.serviceName === name || r.metadata.systemdService === name || r.metadata.dockerContainer === name));

      if (!serviceRes) {
        const metadata = {
          subType: subtype,
          serviceName: name,
          hostId: hostRes.id,
          agentId: agent.id,
          managed: true,
          discovery_sources: ['theta-agent'],
          last_seen: Date.now()
        };
        serviceRes = await Resource.create({
          id: crypto.randomUUID(),
          kind: 'service',
          name: name,
          slug: slug,
          metadata: metadata,
          created_on: Math.floor(Date.now() / 1000)
        }).catch(() => null);
      } else {
        // Backfill the generic field on legacy rows so lookups stay uniform.
        const md = serviceRes.metadata || {};
        if (!md.serviceName) {
          await serviceRes.update({ metadata: { ...md, serviceName: name } }).catch(() => {});
        }
      }

      if (serviceRes) {
        // Parent it under the host unless an edge already exists.
        const edges = await ResourceEdge.list({ where: { childId: serviceRes.id } }).catch(() => []);
        if (!edges.length) {
          await ResourceEdge.create({
            id: crypto.randomUUID(),
            parentId: hostRes.id,
            childId: serviceRes.id,
            relation: 'hosts'
          }).catch(() => {});
        }
      }
    }
  }

  // Register a single service (from an explicit register_service frame).
  async handleServiceRegistration(agent, payload) {
    const name = payload && payload.service;
    if (!name) throw new Error('register_service: missing service name');
    const subtype = (payload && (payload.subtype || payload.subType)) || 'systemd';
    await this.reconcileServicesFromTelemetry(agent, [{ name, subtype }]);
    console.log(`[AgentManager] "${agent.name}" registered ${subtype} service ${name}`);
  }

  // Remove a service resource (and its host edge) from the directory.
  async handleServiceUnregistration(agent, payload) {
    const name = payload && payload.service;
    if (!name) throw new Error('unregister_service: missing service name');

    const { Resource, ResourceEdge } = require('../models/resource');
    let hostRes = null;
    if (agent.resourceId) {
      hostRes = await Resource.get(agent.resourceId).catch(() => null);
    }
    if (!hostRes) {
      const hosts = await Resource.list({ where: { kind: 'host' } }).catch(() => []);
      hostRes = hosts.find(h => h.metadata && h.metadata.agentId === agent.id) || null;
    }

    const services = await Resource.list({ where: { kind: 'service' } }).catch(() => []);
    const target = services.find(r =>
      r.metadata &&
      (r.metadata.serviceName === name || r.metadata.systemdService === name || r.metadata.dockerContainer === name) &&
      (!hostRes || r.metadata.hostId === hostRes.id)
    );

    if (!target) {
      console.log(`[AgentManager] "${agent.name}" unregister ${name}: no such service resource`);
      return;
    }
    const edges = await ResourceEdge.list({ where: { childId: target.id } }).catch(() => []);
    for (const e of edges) await e.delete().catch(() => {});
    await target.delete().catch(() => {});
    console.log(`[AgentManager] "${agent.name}" unregistered ${name}`);
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

  // Find connected/enrolled agent bound to a resource ID (or inherited from parent Host).
  async getAgentForResource(resourceId) {
    if (!resourceId) return null;
    const rows = await Agent.list().catch(() => []);
    let agent = rows.find(a => a.resourceId === resourceId);
    if (!agent) {
      try {
        const { Resource } = require('../models/resource');
        const { ResourceEdge } = require('../models/resource');
        const res = await Resource.get(resourceId);
        if (res && res.kind === 'service') {
          const edges = await ResourceEdge.list({ where: { childId: resourceId } });
          for (const edge of edges) {
            const parentRes = await Resource.get(edge.parentId);
            if (parentRes && parentRes.kind === 'host') {
              agent = rows.find(a => a.resourceId === parentRes.id || (parentRes.metadata && parentRes.metadata.agentId === a.id));
              if (agent) break;
            }
          }
        }
      } catch (err) {
        console.error('[AgentManager] parent agent lookup error:', err.message);
      }
    }
    if (!agent) return null;
    return agent.toPublic(this.liveState(agent.id));
  }

  // Every enrolled agent, connected or not.
  async listAgents() {
    const rows = await Agent.list();
    return rows.map(a => a.toPublic(this.liveState(a.id)));
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
}

module.exports = new AgentManager();
module.exports.AgentManager = AgentManager;
