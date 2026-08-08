'use strict';

const { _Interfaces: Interfaces } = require('../plugins/discovery/proxmox');

// Regression coverage for the MAC/IP mismatch: the plugin used to collect MACs
// and IPs into two flat lists and zip them by index, so on a multi-NIC guest
// -- or any guest where one NIC had no address -- the directory recorded an IP
// against the wrong MAC. Interfaces keys by MAC so a pairing can only come from
// the source that observed both together.
describe('proxmox Interfaces', () => {
	test('keeps each IP on the NIC it was observed on', () => {
		const i = new Interfaces();
		i.add('AA:BB:CC:00:00:01', ['10.0.0.5'], 'eth0');
		i.add('AA:BB:CC:00:00:02', ['192.168.9.7'], 'eth1');

		expect(i.toArray()).toEqual([
			{ mac: 'aa:bb:cc:00:00:01', ip: '10.0.0.5', ips: ['10.0.0.5'], name: 'eth0' },
			{ mac: 'aa:bb:cc:00:00:02', ip: '192.168.9.7', ips: ['192.168.9.7'], name: 'eth1' },
		]);
	});

	test('a NIC with no address does not steal the next NIC\'s IP', () => {
		const i = new Interfaces();
		i.add('AA:BB:CC:00:00:01', [], 'eth0');      // stopped/unconfigured
		i.add('AA:BB:CC:00:00:02', ['10.0.0.9'], 'eth1');

		const byMac = Object.fromEntries(i.toArray().map(x => [x.mac, x.ip]));
		expect(byMac['aa:bb:cc:00:00:01']).toBeNull();
		expect(byMac['aa:bb:cc:00:00:02']).toBe('10.0.0.9');
	});

	test('merges the config MAC with the agent-reported address for the same NIC', () => {
		const i = new Interfaces();
		i.add('aa:bb:cc:00:00:01', ['10.0.0.5'], 'eth0'); // guest agent
		i.add('AA:BB:CC:00:00:01', [], 'net0');           // VM config, same NIC
		expect(i.toArray()).toHaveLength(1);
		expect(i.toArray()[0]).toMatchObject({ mac: 'aa:bb:cc:00:00:01', ip: '10.0.0.5' });
	});

	test('collects multiple addresses on one NIC without inventing a second NIC', () => {
		const i = new Interfaces();
		i.add('aa:bb:cc:00:00:01', ['10.0.0.5', '10.0.0.6'], 'eth0');
		expect(i.toArray()).toHaveLength(1);
		expect(i.toArray()[0].ips).toEqual(['10.0.0.5', '10.0.0.6']);
		expect(i.primaryIp()).toBe('10.0.0.5');
	});

	test('ignores placeholder and malformed MACs', () => {
		const i = new Interfaces();
		i.add('00:00:00:00:00:00', [], 'eth0');
		i.add('not-a-mac', [], 'eth1');
		i.add('', [], 'eth2');
		expect(i.toArray()).toEqual([]);
		expect(i.primaryMac()).toBeNull();
	});

	test('keeps an address that arrived without a usable MAC', () => {
		const i = new Interfaces();
		i.add(null, ['10.0.0.5'], 'eth0');
		expect(i.primaryIp()).toBe('10.0.0.5');
		expect(i.primaryMac()).toBeNull();
	});

	test('primary values prefer a NIC that actually has an address', () => {
		const i = new Interfaces();
		i.add('aa:bb:cc:00:00:01', [], 'eth0');
		i.add('aa:bb:cc:00:00:02', ['10.0.0.9'], 'eth1');
		expect(i.primaryIp()).toBe('10.0.0.9');
		expect(i.primaryMac()).toBe('aa:bb:cc:00:00:02');
	});

	test('a fully unaddressed guest still reports its MAC', () => {
		const i = new Interfaces();
		i.add('aa:bb:cc:00:00:01', [], 'net0');
		expect(i.primaryIp()).toBeNull();
		expect(i.primaryMac()).toBe('aa:bb:cc:00:00:01');
	});
});
