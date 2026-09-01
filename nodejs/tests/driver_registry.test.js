'use strict';

jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
  request: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}), { virtual: true });

const DriverRegistry = require('../services/driver_registry');

describe('Subtype Driver Registry Engine', () => {

  test('resolves ProxmoxDriver for proxmox/hypervisor host subtype', async () => {
    const resource = {
      id: 'res-proxmox-1',
      name: 'pve0',
      kind: 'host',
      metadata: { subType: 'proxmox' }
    };
    const driver = await DriverRegistry.resolveDriver(resource);
    expect(driver.name).toBe('proxmox');
  });

  test('resolves DockerSocketDriver for docker/docker_compose subtype', async () => {
    const resource = {
      id: 'res-docker-1',
      name: 'theta-suite-docker',
      kind: 'service',
      metadata: { subType: 'docker' }
    };
    const driver = await DriverRegistry.resolveDriver(resource);
    expect(driver.name).toBe('docker_socket');
  });

  test('resolves DbDriver for redis, postgresql, openbao_vault subtypes', async () => {
    const redisRes = { id: 'r1', metadata: { subType: 'redis' } };
    const pgRes = { id: 'r2', metadata: { subType: 'postgresql' } };
    const vaultRes = { id: 'r3', metadata: { subType: 'openbao_vault' } };

    expect((await DriverRegistry.resolveDriver(redisRes)).name).toBe('database');
    expect((await DriverRegistry.resolveDriver(pgRes)).name).toBe('database');
    expect((await DriverRegistry.resolveDriver(vaultRes)).name).toBe('database');
  });

  test('resolves NetworkDriver for wireguard, unifi_ap, pfsense', async () => {
    const wgRes = { id: 'nw1', metadata: { subType: 'wireguard' } };
    const unifiRes = { id: 'nw2', metadata: { subType: 'unifi_ap' } };
    const pfRes = { id: 'nw3', metadata: { subType: 'pfsense' } };

    expect((await DriverRegistry.resolveDriver(wgRes)).name).toBe('network');
    expect((await DriverRegistry.resolveDriver(unifiRes)).name).toBe('network');
    expect((await DriverRegistry.resolveDriver(pfRes)).name).toBe('network');
  });

  test('resolves K8sDriver for k8s_pod and k8s_deployment', async () => {
    const podRes = { id: 'k1', metadata: { subType: 'k8s_pod' } };
    const depRes = { id: 'k2', metadata: { subType: 'k8s_deployment' } };

    expect((await DriverRegistry.resolveDriver(podRes)).name).toBe('kubernetes');
    expect((await DriverRegistry.resolveDriver(depRes)).name).toBe('kubernetes');
  });

  test('returns unmanaged driver for unknown subtypes without agent', async () => {
    const unknownRes = { id: 'u1', metadata: { subType: 'unknown_custom' } };
    const driver = await DriverRegistry.resolveDriver(unknownRes);
    expect(driver.name).toBe('unmanaged');
  });

  test('fetches metrics via resolved driver', async () => {
    const redisRes = { id: 'r1', metadata: { subType: 'redis' } };
    const metrics = await DriverRegistry.getMetrics(redisRes);
    expect(metrics.status).toBe('online');
    expect(metrics.driver).toBe('database');
    expect(metrics.redis).toBeDefined();
    expect(metrics.redis.connectedClients).toBeGreaterThan(0);
  });

  test('executes actions via resolved driver', async () => {
    const dockerRes = { id: 'd1', slug: 'my-container', metadata: { subType: 'docker' } };
    const result = await DriverRegistry.execAction(dockerRes, 'restart');
    expect(result.status).toBe('ok');
    expect(result.driver).toBe('docker_socket');
    expect(result.action).toBe('restart');
  });

});

// Regression test for the exact seam that broke: resolveDriver()'s tier 1 is
// documented as "prefer a connected theta-agent over a hypervisor API", but
// getAgentForResource(hostId) had no "host -> its agent-service child"
// direction, so tier 1 silently never fired for a Proxmox-guest host with a
// bound agent and the Proxmox driver always won. Needs the real ORM (unlike
// the plain-stub tests above) because it exercises the actual
// AgentManager.getAgentForResource lookup, not a stub.
describe('Subtype Driver Registry Engine - tier 1 agent preference', () => {
  const { Resource, ResourceEdge } = require('../models/resource');
  const { Agent } = require('../models/agent');
  const { initORM } = require('../models');

  beforeAll(async () => {
    await initORM();
  });

  beforeEach(async () => {
    for (const a of await Agent.list().catch(() => [])) await a.delete().catch(() => {});
    for (const e of await ResourceEdge.list().catch(() => [])) await e.delete().catch(() => {});
    for (const r of await Resource.list().catch(() => [])) await r.delete().catch(() => {});
  });

  test('a connected agent on a Proxmox-guest host outranks the Proxmox driver', async () => {
    const host = await Resource.create({
      id: 'lxc-emby-6e65df28bb21-id', kind: 'host', name: 'emby',
      slug: 'lxc-emby-6e65df28bb21', metadata: { subType: 'lxc' }
    });
    const agentSvc = await Resource.create({
      id: 'svc-emby-theta-agent-id', kind: 'service', name: 'Theta Agent',
      slug: 'svc-emby-theta-agent', metadata: { subType: 'theta-agent' }
    });
    await ResourceEdge.create({ id: 'edge1', parentId: host.id, childId: agentSvc.id, relation: 'hosts' });
    await Agent.create({
      id: 'agent-emby-id', name: 'emby', resourceId: agentSvc.id, tokenHash: 't',
      last_seen: Math.floor(Date.now() / 1000) // recently seen -> isOnline
    });

    const driver = await DriverRegistry.resolveDriver(host);
    expect(driver.name).toBe('theta_agent');
  });

  test('falls back to the Proxmox driver when the host has no bound agent', async () => {
    const host = await Resource.create({
      id: 'lxc-noagent-id', kind: 'host', name: 'noagent',
      slug: 'lxc-noagent', metadata: { subType: 'lxc' }
    });
    const driver = await DriverRegistry.resolveDriver(host);
    expect(driver.name).toBe('proxmox');
  });
});
