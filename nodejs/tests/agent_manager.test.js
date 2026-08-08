'use strict';

const crypto = require('crypto');

// In-memory stand-in for OpenBao. The signing key lives at secret/agent/
// signing-key in production; here we only need it to persist across calls so
// the "same key every time" property is actually exercised rather than mocked
// away.
const mockBaoStore = new Map();
jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(async (path) => mockBaoStore.get(path) || null),
  set: jest.fn(async (path, value) => { mockBaoStore.set(path, value); }),
  request: jest.fn(async () => ({ ok: true, status: 200 }))
}));

const agentManager = require('../utils/agent_manager');
const agentKeys = require('../utils/agent_keys');

// The manager is now keyed by enrolled Agent rows rather than by a bare token
// string, so these use a stub row with the same surface the real model gives:
// an id, and an update() that records what would be persisted.
function stubAgent(overrides = {}) {
  const row = {
    id: overrides.id || crypto.randomUUID(),
    name: overrides.name || 'test-agent',
    resourceId: overrides.resourceId || null,
    revoked: false,
    persisted: {},
    ...overrides
  };
  row.update = jest.fn(async (patch) => {
    Object.assign(row.persisted, patch);
    Object.assign(row, patch);
    return row;
  });
  return row;
}

describe('AgentManager PROTOCOL.md v1.2.0 Compliance', () => {
  let mockWs;
  let sentMessages;
  let agent;

  beforeEach(() => {
    sentMessages = [];
    mockWs = {
      readyState: 1, // OPEN
      send: jest.fn((msg) => sentMessages.push(JSON.parse(msg))),
      close: jest.fn()
    };
    agent = stubAgent();
  });

  test('registers an agent and reports it as connected', () => {
    agentManager.registerAgent(agent, mockWs, '192.168.1.100');
    const state = agentManager.liveState(agent.id);
    expect(state.connected).toBe(true);
    expect(state.ipAddress).toBe('192.168.1.100');
    expect(agentManager.isConnected(agent.id)).toBe(true);
  });

  // registerAgent must not be async: the WS `message` listener is attached in
  // the same tick, and `ws` drops events emitted before a listener exists. An
  // awaited DB write here swallowed every agent's first discovery frame, which
  // is the one it sends immediately on connect.
  test('registerAgent is synchronous so no message can be missed', () => {
    const result = agentManager.registerAgent(agent, mockWs, '10.0.0.1');
    expect(result).toBeUndefined();
    expect(agentManager.isConnected(agent.id)).toBe(true);
  });

  test('persists discovery to the agent row (Section 3.1)', async () => {
    agentManager.registerAgent(agent, mockWs, '192.168.1.100');
    await agentManager.handleDiscovery(agent, {
      hostname: 'node-01.local',
      ip_addresses: ['192.168.1.100', '10.0.0.5'],
      os: 'Ubuntu 24.04 LTS',
      kernel: '6.8.0-31-generic',
      cpu: 'AMD EPYC 7763',
      ram_total_gb: 32.0,
      disk_total_gb: 500.0,
      location: 'dc-chicago-rack-4'
    });

    const saved = agent.persisted.lastDiscovery;
    expect(saved.hostname).toBe('node-01.local');
    expect(saved.os).toBe('Ubuntu 24.04 LTS');
    expect(saved.ip_addresses).toEqual(['192.168.1.100', '10.0.0.5']);
    // Durable, not just in memory: an agent that goes offline keeps its facts.
    expect(agent.persisted.last_seen).toEqual(expect.any(Number));
  });

  test('persists telemetry to the agent row (Section 3.2)', async () => {
    agentManager.registerAgent(agent, mockWs, '192.168.1.100');
    await agentManager.handleTelemetry(agent, {
      cpu_usage_percent: 14.5,
      ram_usage_percent: 42.1,
      disk_usage_percent: 68.0,
      zfs_health: 'ONLINE',
      gpu_usage_percent: -1.0,
      timestamp: new Date().toISOString()
    });

    expect(agent.persisted.lastTelemetry.cpu_usage_percent).toBe(14.5);
    expect(agent.persisted.lastTelemetry.zfs_health).toBe('ONLINE');
  });

  test('responds to heartbeat with heartbeat_ack (Section 3.3)', async () => {
    agentManager.registerAgent(agent, mockWs, '192.168.1.100');
    await agentManager.handleHeartbeat(agent, { timestamp: new Date().toISOString() }, mockWs);

    expect(mockWs.send).toHaveBeenCalled();
    const lastMsg = sentMessages[sentMessages.length - 1];
    expect(lastMsg.type).toBe('heartbeat_ack');
    expect(lastMsg.payload.timestamp).toBeDefined();
  });

  test('canonicalizes and signs high-risk commands with Ed25519 (Section 5)', async () => {
    agentManager.registerAgent(agent, mockWs, '192.168.1.100');

    const rawPayload = { script: 'uptime', location: 'datacenter' };
    const msg = await agentManager.sendCommand(agent, 'arbitrary_bash', rawPayload, true);

    expect(msg.type).toBe('arbitrary_bash');
    expect(typeof msg.payload.signature).toBe('string');

    const keys = await agentKeys.load();
    const isValid = crypto.verify(
      null,
      Buffer.from(agentManager.canonicalize(rawPayload), 'utf8'),
      crypto.createPublicKey(keys.publicKeyPem),
      Buffer.from(msg.payload.signature, 'base64')
    );
    expect(isValid).toBe(true);
  });

  // The canonical form has to match the Go agent's byte for byte. Go's
  // encoding/json escapes <, > and & by default and JSON.stringify does not, so
  // the agent uses SetEscapeHTML(false); this pins the server's half of that
  // contract. See theta-agent TestCanonicalizeMatchesServerForm.
  test('canonical form is sorted, unescaped, and omits the signature', () => {
    const canonical = agentManager.canonicalize({
      script: 'echo a > b && c',
      comment: 'x&y',
      signature: 'should-not-appear'
    });
    expect(canonical).toBe('{"comment":"x&y","script":"echo a > b && c"}');
  });

  test('refuses to send to an agent that is not connected', async () => {
    await expect(agentManager.sendCommand(agent, 'reload_config', {}, false))
      .rejects.toThrow(/not connected/);
  });

  // Revocation that only applies on the next reconnect is not revocation.
  test('disconnect drops the live socket immediately', () => {
    agentManager.registerAgent(agent, mockWs, '192.168.1.100');
    expect(agentManager.isConnected(agent.id)).toBe(true);

    const dropped = agentManager.disconnect(agent.id, 4003, 'Enrollment revoked');
    expect(dropped).toBe(true);
    expect(mockWs.close).toHaveBeenCalledWith(4003, 'Enrollment revoked');
    expect(agentManager.isConnected(agent.id)).toBe(false);
  });

  test('a second connection for the same agent supersedes the first', () => {
    agentManager.registerAgent(agent, mockWs, '192.168.1.100');
    const secondWs = { readyState: 1, send: jest.fn(), close: jest.fn() };
    agentManager.registerAgent(agent, secondWs, '192.168.1.101');

    expect(mockWs.close).toHaveBeenCalledWith(4002, 'Superseded by new connection');
    expect(agentManager.liveState(agent.id).ipAddress).toBe('192.168.1.101');
  });

  test('an unknown agent id is simply not connected', () => {
    expect(agentManager.isConnected('no-such-agent')).toBe(false);
    expect(agentManager.liveState('no-such-agent')).toEqual({ connected: false, lastResponse: null });
  });
});

describe('agent signing key', () => {
  // The old manager generated a key pair in its constructor, so it changed on
  // every restart and the public_key pinned in agent.yml stopped matching.
  test('the same key is returned across repeated loads', async () => {
    const first = await agentKeys.load();
    const second = await agentKeys.load();
    expect(first.publicKeyBase64).toBe(second.publicKeyBase64);
  });

  test('the exported public key is the raw 32 bytes agents pin', async () => {
    const keys = await agentKeys.load();
    expect(Buffer.from(keys.publicKeyBase64, 'base64')).toHaveLength(32);
  });

  test('rawPublicKeyBase64 strips the SPKI wrapper', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' }
    });
    const raw = Buffer.from(agentKeys.rawPublicKeyBase64(publicKey), 'base64');
    expect(raw).toHaveLength(32);
    // and it is the tail of the DER encoding
    const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    expect(raw.equals(der.subarray(der.length - 32))).toBe(true);
  });
});
