'use strict';

// tcpReachable is the cheap half of "prefer this address, fall back to that
// one". It has to answer fast and it has to answer honestly -- a probe that
// reports a dead address as reachable is worse than no probe, because the
// caller then spends its full request timeout on it anyway.

const net = require('net');
const { tcpReachable } = require('../utils/tcp_probe');

const listen = () => new Promise((resolve) => {
  const server = net.createServer(() => {});
  server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
});

describe('tcpReachable', () => {
  test('true for a port something is listening on', async () => {
    const { server, port } = await listen();
    try {
      await expect(tcpReachable('127.0.0.1', port, 1000)).resolves.toBe(true);
    } finally {
      server.close();
    }
  });

  test('false for a port nothing is listening on', async () => {
    // Bind then release, so the port is real but closed.
    const { server, port } = await listen();
    await new Promise((r) => server.close(r));
    await expect(tcpReachable('127.0.0.1', port, 1000)).resolves.toBe(false);
  });

  test('false, within the timeout, for an address that never answers', async () => {
    // 10.255.255.1 is routable-looking and unassigned: a connect there hangs
    // rather than being refused, which is exactly the mesh-address case this
    // exists for.
    const started = Date.now();
    await expect(tcpReachable('10.255.255.1', 3001, 300)).resolves.toBe(false);
    // The point of the probe is that it gives up quickly. Generous upper bound
    // so a loaded CI box doesn't fail it, but far below the 8s request timeout
    // it exists to avoid.
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('false for a hostname that does not resolve', async () => {
    await expect(tcpReachable('no-such-host.invalid', 3001, 1000)).resolves.toBe(false);
  });

  test('never throws, whatever it is given', async () => {
    await expect(tcpReachable('', 0, 100)).resolves.toBe(false);
  });
});
