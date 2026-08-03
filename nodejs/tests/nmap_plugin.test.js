'use strict';

const nmapPlugin = require('../plugins/discovery/nmap');

jest.mock('node-nmap', () => {
  const EventEmitter = require('events');
  class MockNmapScan extends EventEmitter {
    constructor(targetRange, customFlags) {
      super();
      this.targetRange = targetRange;
      this.customFlags = customFlags;
      this.command = ['-oX', '-', ...(customFlags || []), targetRange];
    }
    startScan() {
      setImmediate(() => {
        this.emit('complete', [
          { ip: '192.168.1.10', hostname: 'host-10', openPorts: [{ port: 80, protocol: 'tcp', service: 'http' }] }
        ]);
      });
    }
  }
  return {
    NmapScan: MockNmapScan,
    nmapLocation: 'nmap'
  };
});

describe('nmap discovery plugin', () => {
  test('discover passes custom flags (-Pn, -sT, -F, --min-rate) to constructor', async () => {
    const logs = [];
    const result = await nmapPlugin.discover({
      targetRange: '192.168.1.0/24',
      log: (msg) => { logs.push(msg); }
    });

    const startLog = logs.find(l => l.startsWith('Starting nmap scan'));
    expect(startLog).toBeDefined();
    expect(startLog).toContain('-Pn');
    expect(startLog).toContain('-sT');
    expect(startLog).toContain('-F');
    expect(startLog).toContain('--min-rate 100');
    expect(result.resources).toHaveLength(2); // host + service
    expect(result.resources[0].name).toBe('host-10');
    expect(result.edges).toHaveLength(1);
  });
});
