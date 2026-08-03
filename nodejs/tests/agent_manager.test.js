'use strict';

const crypto = require('crypto');
const agentManager = require('../utils/agent_manager');

describe('AgentManager PROTOCOL.md v1.1.0 Compliance', () => {
  let mockWs;
  let sentMessages;

  beforeEach(() => {
    sentMessages = [];
    mockWs = {
      readyState: 1, // OPEN
      send: jest.fn((msg) => sentMessages.push(JSON.parse(msg))),
      close: jest.fn()
    };
  });

  test('registers agent and tracks initial connection state', () => {
    const record = agentManager.registerAgent('test-token-123', mockWs, '192.168.1.100');
    expect(record.token).toBe('test-token-123');
    expect(record.ipAddress).toBe('192.168.1.100');

    const agents = agentManager.getConnectedAgents();
    const found = agents.find(a => a.token === 'test-token-123');
    expect(found).toBeDefined();
    expect(found.isOnline).toBe(true);
  });

  test('processes discovery payload per PROTOCOL.md v1.1.0 Section 3.1', () => {
    agentManager.registerAgent('test-token-123', mockWs, '192.168.1.100');

    const discoveryPayload = {
      hostname: 'node-01.local',
      ip_addresses: ['192.168.1.100', '10.0.0.5'],
      os: 'Ubuntu 24.04 LTS',
      kernel: '6.8.0-31-generic',
      cpu: 'AMD EPYC 7763',
      ram_total_gb: 32.0,
      disk_total_gb: 500.0,
      location: 'dc-chicago-rack-4'
    };

    agentManager.handleDiscovery('test-token-123', discoveryPayload);

    const agents = agentManager.getConnectedAgents();
    const agent = agents.find(a => a.token === 'test-token-123');
    expect(agent.hostname).toBe('node-01.local');
    expect(agent.discovery.os).toBe('Ubuntu 24.04 LTS');
    expect(agent.discovery.ip_addresses).toEqual(['192.168.1.100', '10.0.0.5']);
  });

  test('processes telemetry payload per PROTOCOL.md v1.1.0 Section 3.2', () => {
    agentManager.registerAgent('test-token-123', mockWs, '192.168.1.100');

    const telemetryPayload = {
      cpu_usage_percent: 14.5,
      ram_usage_percent: 42.1,
      disk_usage_percent: 68.0,
      zfs_health: 'ONLINE',
      gpu_usage_percent: -1.0,
      timestamp: new Date().toISOString()
    };

    agentManager.handleTelemetry('test-token-123', telemetryPayload);

    const agents = agentManager.getConnectedAgents();
    const agent = agents.find(a => a.token === 'test-token-123');
    expect(agent.telemetry.cpu_usage_percent).toBe(14.5);
    expect(agent.telemetry.zfs_health).toBe('ONLINE');
  });

  test('responds to heartbeat with heartbeat_ack per Section 3.3', () => {
    agentManager.registerAgent('test-token-123', mockWs, '192.168.1.100');

    agentManager.handleHeartbeat('test-token-123', { timestamp: new Date().toISOString() }, mockWs);

    expect(mockWs.send).toHaveBeenCalled();
    const lastMsg = sentMessages[sentMessages.length - 1];
    expect(lastMsg.type).toBe('heartbeat_ack');
    expect(lastMsg.payload.timestamp).toBeDefined();
  });

  test('canonicalizes payload and signs high-risk commands using Ed25519 per Section 5', () => {
    agentManager.registerAgent('test-token-123', mockWs, '192.168.1.100');

    const rawPayload = { script: 'uptime', location: 'datacenter' };
    const msg = agentManager.sendCommand('test-token-123', 'arbitrary_bash', rawPayload, true);

    expect(msg.type).toBe('arbitrary_bash');
    expect(msg.payload.signature).toBeDefined();
    expect(typeof msg.payload.signature).toBe('string');

    // Verify signature with public key
    const signatureBuffer = Buffer.from(msg.payload.signature, 'base64');
    const canonicalStr = agentManager.canonicalize(rawPayload);
    const isValid = crypto.verify(null, Buffer.from(canonicalStr, 'utf8'), agentManager.publicKeyPem, signatureBuffer);
    expect(isValid).toBe(true);
  });
});
