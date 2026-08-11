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
      this.rawData = '';
    }
    startScan() {
      setImmediate(() => {
        this.emit('complete', [
          { ip: '192.168.1.10', hostname: 'host-10', openPorts: [{ port: 80, protocol: 'tcp', service: 'http' }] }
        ]);
      });
    }
    // Real node-nmap's rawDataHandler XML-parses this.rawData then calls
    // this.scanComplete(results), which emits 'complete' -- the mock skips
    // straight to emitting the same shape so the RTTVAR-recovery test below
    // exercises the exact call our plugin code makes.
    rawDataHandler() {
      this.emit('complete', [
        { ip: '192.168.1.20', hostname: 'host-20', openPorts: [] }
      ]);
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

  test('recovers a scan that completed despite nmap\'s benign RTTVAR stderr warning', async () => {
    // Regression: node-nmap treats ANY stderr output as fatal, including
    // nmap's own harmless RTT-calibration message -- which discards a scan
    // that actually succeeded. Simulate that by emitting 'error' with the
    // RTTVAR text instead of 'complete', with rawData present.
    const nmapModule = require('node-nmap');
    const originalStartScan = nmapModule.NmapScan.prototype.startScan;
    nmapModule.NmapScan.prototype.startScan = function () {
      this.rawData = '<nmaprun>...</nmaprun>';
      setImmediate(() => {
        this.emit('error', new Error('RTTVAR has grown to over 2.3 seconds, decreasing to 2.0'));
      });
    };

    try {
      const result = await nmapPlugin.discover({ targetRange: '192.168.1.0/24' });
      expect(result.resources.some((r) => r.name === 'host-20')).toBe(true);
    } finally {
      nmapModule.NmapScan.prototype.startScan = originalStartScan;
    }
  });

  test('still rejects a genuine error even when the message differs from RTTVAR', async () => {
    const nmapModule = require('node-nmap');
    const originalStartScan = nmapModule.NmapScan.prototype.startScan;
    nmapModule.NmapScan.prototype.startScan = function () {
      setImmediate(() => {
        this.emit('error', new Error('nmap: permission denied'));
      });
    };

    try {
      await expect(nmapPlugin.discover({ targetRange: '192.168.1.0/24' })).rejects.toThrow('permission denied');
    } finally {
      nmapModule.NmapScan.prototype.startScan = originalStartScan;
    }
  });
});
