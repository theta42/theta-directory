'use strict';

jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
  request: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}), { virtual: true });

// The driver reaches the agent only through AgentManager, so the whole surface
// is exercisable by standing in for it.
jest.mock('../utils/agent_manager', () => ({
  getAgentForResource: jest.fn(),
  sendCommand: jest.fn(),
}));

const AgentManager = require('../utils/agent_manager');
const ThetaAgentDriver = require('../drivers/theta_agent_driver');

const driver = new ThetaAgentDriver();

const ONLINE_AGENT = {
  id: 'agent-1',
  isOnline: true,
  lastSeen: '2026-08-24T00:00:00Z',
  version: 'v2.14.0',
  toPublic: () => ({
    latestTelemetry: {
      cpu: 3, memory: 40, disk: 55,
      services: [
        { name: 'emby-server', subtype: 'systemd', active: true, substate: 'running',
          cpu_usage_percent: 1.5, memory_bytes: 1048576, n_restarts: 2, uptime_seconds: 3600 }
      ]
    }
  })
};

// A service resource exactly as agent_manager.js's reconciler creates one: the
// slug is derived, the UNIT name lives in metadata.serviceName.
const EMBY = {
  id: 'svc-1',
  kind: 'service',
  name: 'emby-server',
  slug: 'svc-lxc-213-systemd-emby-server',
  metadata: { subType: 'systemd', serviceName: 'emby-server', hostId: 'h1', agentId: 'agent-1' }
};

beforeEach(() => {
  AgentManager.getAgentForResource.mockReset();
  AgentManager.sendCommand.mockReset();
  AgentManager.sendCommand.mockResolvedValue({ status: 'ok', output: '' });
});

describe('the agent lookup is awaited', () => {
  // The regression behind "it showed up in directory but there is no UI to see
  // its stats or control it": getAgentForResource is async, and every call in
  // this driver was made without await. `!agent.isOnline` on a Promise is
  // always true, so getMetrics reported the agent offline unconditionally and
  // the live-status panel could never render anything.
  test('getMetrics returns live data for an online agent', async () => {
    AgentManager.getAgentForResource.mockResolvedValue(ONLINE_AGENT);
    const m = await driver.getMetrics(EMBY);
    expect(m.status).toBe('online');
    expect(m.service).toBeDefined();
    expect(m.service.active).toBe(true);
    expect(m.service.memory_bytes).toBe(1048576);
  });

  test('and still reports offline when the agent really is offline', async () => {
    AgentManager.getAgentForResource.mockResolvedValue({ id: 'a', isOnline: false, toPublic: () => ({}) });
    const m = await driver.getMetrics(EMBY);
    expect(m.status).toBe('offline');
  });

  test('execAction reaches the agent instead of always saying "not connected"', async () => {
    AgentManager.getAgentForResource.mockResolvedValue(ONLINE_AGENT);
    const r = await driver.execAction(EMBY, 'service_action', { subAction: 'restart' });
    expect(r.status).toBe('ok');
    expect(AgentManager.sendCommand).toHaveBeenCalled();
  });
});

describe('the command targets the unit, not the slug', () => {
  test('serviceName wins over everything', () => {
    expect(ThetaAgentDriver.serviceTarget(EMBY)).toBe('emby-server');
  });

  test('a restart sends the unit name and the subtype', async () => {
    AgentManager.getAgentForResource.mockResolvedValue(ONLINE_AGENT);
    await driver.execAction(EMBY, 'service_action', { subAction: 'restart' });
    const [, type, payload] = AgentManager.sendCommand.mock.calls[0];
    expect(type).toBe('systemd_action');
    // `svc-lxc-213-systemd-emby-server` is not a unit on any host; sending it
    // meant every start/stop/restart silently acted on nothing.
    expect(payload.service).toBe('emby-server');
    expect(payload.subtype).toBe('systemd');
    expect(payload.action).toBe('restart');
    // stop and restart interrupt something running; start does not.
    expect(payload.isHighRisk).toBe(true);
  });

  test('start is not flagged high-risk', async () => {
    AgentManager.getAgentForResource.mockResolvedValue(ONLINE_AGENT);
    await driver.execAction(EMBY, 'service_action', { subAction: 'start' });
    expect(AgentManager.sendCommand.mock.calls[0][2].isHighRisk).toBe(false);
  });

  test('legacy systemdService resources still resolve', () => {
    const legacy = { kind: 'service', name: 'x', slug: 'svc-x', metadata: { subType: 'systemd', systemdService: 'nginx' } };
    expect(ThetaAgentDriver.serviceTarget(legacy)).toBe('nginx');
  });

  test('a docker resource resolves through dockerContainer', () => {
    const c = { kind: 'service', name: 'x', slug: 'svc-x', metadata: { subType: 'docker', dockerContainer: 'redis' } };
    expect(ThetaAgentDriver.serviceTarget(c)).toBe('redis');
  });
});

describe('the action allowlist', () => {
  beforeEach(() => AgentManager.getAgentForResource.mockResolvedValue(ONLINE_AGENT));

  test('refuses an action outside the set', async () => {
    for (const bad of ['mask', 'enable', 'restart; rm -rf /']) {
      const r = await driver.execAction(EMBY, 'service_action', { subAction: bad });
      expect(r.status).toBe('error');
    }
    expect(AgentManager.sendCommand).not.toHaveBeenCalled();
  });

  test('refuses control of a subtype with no lifecycle', async () => {
    // A timer or a cron entry has no start/stop; offering a button that can
    // only fail is worse than offering none.
    const timer = { ...EMBY, metadata: { ...EMBY.metadata, subType: 'systemd-timer' } };
    const r = await driver.execAction(timer, 'service_action', { subAction: 'restart' });
    expect(r.status).toBe('error');
    expect(AgentManager.sendCommand).not.toHaveBeenCalled();
  });

  test('accepts the four real actions for a controllable subtype', async () => {
    for (const good of ['start', 'stop', 'restart', 'reload']) {
      AgentManager.sendCommand.mockClear();
      const r = await driver.execAction(EMBY, 'service_action', { subAction: good });
      expect(r.status).toBe('ok');
      expect(AgentManager.sendCommand).toHaveBeenCalledTimes(1);
    }
  });
});

describe('supports()', () => {
  test('does not claim every resource in the catalog', () => {
    // It used to end with an un-awaited async call compared against null,
    // which is never null -- so this returned true for anything.
    expect(driver.supports({ kind: 'host', metadata: { subType: 'proxmox' } })).toBe(false);
    expect(driver.supports({ kind: 'oauth', metadata: {} })).toBe(false);
    expect(driver.supports(EMBY)).toBe(true);
    expect(driver.supports({ kind: 'host', metadata: { agentId: 'a1' } })).toBe(true);
  });
});
