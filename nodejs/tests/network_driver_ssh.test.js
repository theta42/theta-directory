'use strict';

const net = require('net');
const NetworkDriver = require('../drivers/network_driver');
const { initORM } = require('../models');
const { Resource } = require('../models/resource');

describe('NetworkDriver SSH Monitoring', () => {
  let driver;
  let mockSshServer;
  const mockPort = 22222;

  beforeAll(async () => {
    await initORM();
    driver = new NetworkDriver();

    await new Promise((resolve) => {
      mockSshServer = net.createServer((socket) => {
        socket.write('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6\r\n');
      });
      mockSshServer.listen(mockPort, '127.0.0.1', resolve);
    });
  });

  afterAll(async () => {
    if (mockSshServer) {
      await new Promise(resolve => mockSshServer.close(resolve));
    }
  });

  test('supports ssh subtype in addition to appliances', () => {
    expect(driver.supports({ metadata: { subType: 'ssh' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'wireguard' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'pfsense' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'unifi_ap' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'postgresql' } })).toBe(false);
  });

  test('probes live SSH port and extracts SSH protocol banner', async () => {
    const res = await Resource.create({
      kind: 'service',
      name: 'Host SSH Service',
      metadata: {
        subType: 'ssh',
        ip: '127.0.0.1',
        port: mockPort
      }
    });

    const metrics = await driver.getMetrics(res);
    expect(metrics.status).toBe('online');
    expect(metrics.driver).toBe('network');
    expect(metrics.ssh).toBeDefined();
    expect(metrics.ssh.port).toBe(mockPort);
    expect(metrics.ssh.reachable).toBe(true);
    expect(metrics.ssh.banner).toContain('SSH-2.0-OpenSSH');
    expect(metrics.ssh.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  test('reports offline when SSH port is closed', async () => {
    const res = await Resource.create({
      kind: 'service',
      name: 'Closed SSH Service',
      metadata: {
        subType: 'ssh',
        ip: '127.0.0.1',
        port: 22223 // Closed port
      }
    });

    const metrics = await driver.getMetrics(res);
    expect(metrics.status).toBe('offline');
    expect(metrics.ssh.reachable).toBe(false);
  });

  test('execAction probe returns probe result', async () => {
    const res = await Resource.create({
      kind: 'service',
      name: 'Host SSH Service',
      metadata: {
        subType: 'ssh',
        ip: '127.0.0.1',
        port: mockPort
      }
    });

    const actionRes = await driver.execAction(res, 'probe');
    expect(actionRes.status).toBe('ok');
    expect(actionRes.probe.reachable).toBe(true);
    expect(actionRes.message).toContain('SSH listening on 127.0.0.1:22222');
  });
});
