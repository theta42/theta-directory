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
