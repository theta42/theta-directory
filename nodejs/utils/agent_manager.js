'use strict';

const crypto = require('crypto');

class AgentManager {
  constructor() {
    this.agents = new Map(); // token -> agentRecord
    this.privateKeyPem = null;
    this.publicKeyPem = null;
    this.initKeyPair();
  }

  initKeyPair() {
    try {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' }
      });
      this.privateKeyPem = privateKey;
      this.publicKeyPem = publicKey;
    } catch (err) {
      console.error('[AgentManager] Failed to generate Ed25519 key pair:', err);
    }
  }

  /**
   * Canonicalize payload for signing per PROTOCOL.md v1.1.0 section 5:
   * Sort keys alphabetically, remove whitespace, omit 'signature' key.
   */
  canonicalize(payload) {
    const cleanObj = {};
    const sortedKeys = Object.keys(payload).filter(k => k !== 'signature').sort();
    for (const key of sortedKeys) {
      cleanObj[key] = payload[key];
    }
    return JSON.stringify(cleanObj);
  }

  /**
   * Sign payload using Ed25519 private key.
   * Returns base64 encoded signature.
   */
  signPayload(payload) {
    if (!this.privateKeyPem) {
      throw new Error('Ed25519 private key is not initialized');
    }
    const canonicalBytes = Buffer.from(this.canonicalize(payload), 'utf8');
    const signature = crypto.sign(null, canonicalBytes, this.privateKeyPem);
    return signature.toString('base64');
  }

  registerAgent(token, ws, remoteAddress) {
    const existing = this.agents.get(token);
    if (existing && existing.ws && existing.ws !== ws) {
      try { existing.ws.close(4002, 'Superseded by new connection'); } catch (e) {}
    }

    const agentRecord = {
      token,
      ws,
      ipAddress: remoteAddress,
      hostname: 'unknown',
      connectedAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      discovery: {},
      telemetry: {},
      pendingResponses: new Map()
    };

    this.agents.set(token, agentRecord);
    return agentRecord;
  }

  unregisterAgent(token, ws) {
    const record = this.agents.get(token);
    if (record && record.ws === ws) {
      this.agents.delete(token);
    }
  }

  handleDiscovery(token, payload) {
    const agent = this.agents.get(token);
    if (!agent) return;

    agent.lastSeen = new Date().toISOString();
    agent.hostname = payload.hostname || agent.hostname;
    agent.discovery = {
      hostname: payload.hostname || '',
      ip_addresses: Array.isArray(payload.ip_addresses) ? payload.ip_addresses : [],
      os: payload.os || '',
      kernel: payload.kernel || '',
      cpu: payload.cpu || '',
      ram_total_gb: payload.ram_total_gb || 0,
      disk_total_gb: payload.disk_total_gb || 0,
      location: payload.location || 'default'
    };
  }

  handleTelemetry(token, payload) {
    const agent = this.agents.get(token);
    if (!agent) return;

    agent.lastSeen = new Date().toISOString();
    agent.telemetry = {
      cpu_usage_percent: payload.cpu_usage_percent || 0,
      ram_usage_percent: payload.ram_usage_percent || 0,
      disk_usage_percent: payload.disk_usage_percent || 0,
      zfs_health: payload.zfs_health || 'N/A',
      gpu_usage_percent: payload.gpu_usage_percent ?? -1,
      timestamp: payload.timestamp || new Date().toISOString()
    };
  }

  handleHeartbeat(token, payload, ws) {
    const agent = this.agents.get(token);
    if (agent) {
      agent.lastSeen = new Date().toISOString();
    }
    try {
      ws.send(JSON.stringify({
        type: 'heartbeat_ack',
        payload: { timestamp: new Date().toISOString() }
      }));
    } catch (e) {}
  }

  handleResponse(token, payload) {
    const agent = this.agents.get(token);
    if (agent) {
      agent.lastSeen = new Date().toISOString();
      agent.lastResponse = {
        status: payload.status || 'ok',
        message: payload.message || '',
        output: payload.output || '',
        timestamp: new Date().toISOString()
      };
    }
  }

  sendCommand(token, commandType, payload = {}, isHighRisk = false) {
    const agent = this.agents.get(token);
    if (!agent || !agent.ws || agent.ws.readyState !== 1) {
      throw new Error(`Agent with token "${token}" is not connected`);
    }

    const finalPayload = { ...payload };
    if (isHighRisk) {
      finalPayload.signature = this.signPayload(finalPayload);
    }

    const message = {
      type: commandType,
      payload: finalPayload
    };

    agent.ws.send(JSON.stringify(message));
    return message;
  }

  getConnectedAgents() {
    const list = [];
    const now = new Date();
    for (const [token, agent] of this.agents.entries()) {
      list.push({
        token,
        hostname: agent.hostname,
        ipAddress: agent.ipAddress,
        connectedAt: agent.connectedAt,
        lastSeen: agent.lastSeen,
        discovery: agent.discovery,
        telemetry: agent.telemetry,
        lastResponse: agent.lastResponse || null,
        isOnline: (now - new Date(agent.lastSeen)) < 90000
      });
    }
    return list;
  }
}

module.exports = new AgentManager();
