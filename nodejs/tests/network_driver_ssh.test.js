'use strict';

const net = require('net');
const NetworkDriver = require('../drivers/network_driver');
const { initORM } = require('../models');
const { Resource } = require('../models/resource');

describe('NetworkDriver SSH Monitoring', () => {
  let driver;
  let mockSshServer;
  // Ephemeral, not a fixed 22222. Jest runs suites in parallel workers and CI
  // runs whole suites concurrently, so a hardcoded port is a standing
  // EADDRINUSE waiting to happen -- and it did, intermittently failing CI on
  // unrelated pull requests. `listen(0)` lets the OS pick a port nothing else
  // holds, and the tests read it back rather than assuming it.
  let mockPort;
  // A port to be REFUSED on. Bound then released, so it is known-closed rather
  // than merely hoped-to-be-closed: an arbitrary "closed" port number can just
  // as easily be in use by something else, which would turn this into the
  // opposite test without saying so.
  let closedPort;

  beforeAll(async () => {
    await initORM();
    driver = new NetworkDriver();

    await new Promise((resolve) => {
      mockSshServer = net.createServer((socket) => {
        socket.write('SSH-2.0-OpenSSH_8.9p1 Ubuntu-3ubuntu0.6\r\n');
      });
      mockSshServer.listen(0, '127.0.0.1', () => {
        mockPort = mockSshServer.address().port;
        resolve();
      });
    });

    await new Promise((resolve) => {
      const throwaway = net.createServer();
      throwaway.listen(0, '127.0.0.1', () => {
        closedPort = throwaway.address().port;
        throwaway.close(resolve);
      });
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
        port: closedPort
      }
    });

    const metrics = await driver.getMetrics(res);
    expect(metrics.status).toBe('offline');
    expect(metrics.ssh.reachable).toBe(false);
  });

  // The live test above is a coin flip on a fast machine: the probe answers in
  // under a millisecond, `responseTimeMs` is 0, and `0 || null` -- which is what
  // the driver used to do -- turned the fastest possible result into "no
  // result". This pins the mapping without depending on how quick the loopback
  // happens to be, which is the only way to hold the line on it.
  test('a zero response time is reported as 0, not as null', async () => {
    const res = await Resource.create({
      kind: 'service',
      name: 'Instant SSH Service',
      metadata: { subType: 'ssh', ip: '127.0.0.1', port: mockPort }
    });

    const probeSpy = jest.spyOn(driver, 'probeSsh').mockResolvedValue({
      reachable: true,
      banner: 'SSH-2.0-OpenSSH_8.9p1',
      port: mockPort,
      responseTimeMs: 0
    });

    try {
      const metrics = await driver.getMetrics(res);
      expect(metrics.ssh.responseTimeMs).toBe(0);
      expect(metrics.ssh.reachable).toBe(true);
    } finally {
      probeSpy.mockRestore();
    }
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
    expect(actionRes.message).toContain(`SSH listening on 127.0.0.1:${mockPort}`);
  });
});
