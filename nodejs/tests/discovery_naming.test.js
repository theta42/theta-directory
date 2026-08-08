'use strict';

// Pure-logic coverage for the two reconciler rules that real Proxmox + UniFi
// data broke. Both were found by running discovery against a live cluster:
// the directory came back listing MAC addresses as host names, and one
// resource ended up as its own parent.

// Mirrors the ranking in services/discovery_reconciler.js. Kept here (rather
// than exported) because it is a few lines of predicate that the reconciler
// applies inline while merging; if it grows, export it and drop this copy.
const isIp = (str) => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(str || '');
const isMac = (str) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test((str || '').trim());
const nameRank = (str) => {
	if (!str || !String(str).trim()) return 0;
	if (isMac(str)) return 0;
	if (isIp(str)) return 1;
	return 2;
};
function bestNameOf(existingName, incomingName) {
	let best = existingName;
	if (incomingName) {
		const a = nameRank(incomingName);
		const b = nameRank(best);
		if (a > b || (a === b && incomingName.length > (best || '').length)) best = incomingName;
	}
	return best;
}

describe('discovery name ranking', () => {
	test('a real hostname beats a MAC even when shorter', () => {
		// The exact regression: UniFi named the host by MAC, Proxmox knew the
		// hostname, and length-only comparison kept the MAC.
		expect(bestNameOf('ac:16:2d:b3:da:80', 'dl380-0')).toBe('dl380-0');
	});

	test('a MAC never displaces a real hostname', () => {
		expect(bestNameOf('dl380-0', 'ac:16:2d:b3:da:80')).toBe('dl380-0');
	});

	test('a real hostname beats an IP-shaped name', () => {
		expect(bestNameOf('192.168.1.27', 'hass.io')).toBe('hass.io');
	});

	test('an IP beats a MAC', () => {
		expect(bestNameOf('bc:24:11:3f:cd:c8', '192.168.1.27')).toBe('192.168.1.27');
	});

	test('an IP does not displace a hostname', () => {
		expect(bestNameOf('gitea-runner', '192.168.1.176')).toBe('gitea-runner');
	});

	test('within the same rank the longer/more specific name wins', () => {
		expect(bestNameOf('pve', 'pve-dl380-1')).toBe('pve-dl380-1');
	});

	test('dash-separated MACs are recognized too', () => {
		expect(bestNameOf('ac-16-2d-b3-da-80', 'dl380-0')).toBe('dl380-0');
	});

	test('an empty existing name is always replaced', () => {
		expect(bestNameOf('', 'anything')).toBe('anything');
		expect(bestNameOf(null, 'ac:16:2d:b3:da:80')).toBe('ac:16:2d:b3:da:80');
	});
});

// Mirrors isDescendant() in the reconciler.
function isDescendant(candidateId, rootId, edges) {
	const seen = new Set();
	const stack = [rootId];
	while (stack.length) {
		const id = stack.pop();
		if (id === candidateId) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const e of edges) if (e.parentId === id) stack.push(e.childId);
	}
	return false;
}

describe('discovery edge cycle guard', () => {
	const edges = [
		{ parentId: 'cluster', childId: 'node1' },
		{ parentId: 'node1', childId: 'vm1' },
	];

	test('detects a direct parent/child inversion', () => {
		// Proposing node1 -> cluster when cluster -> node1 already exists.
		expect(isDescendant('node1', 'cluster', edges)).toBe(true);
	});

	test('detects a deeper loop', () => {
		expect(isDescendant('vm1', 'cluster', edges)).toBe(true);
	});

	test('allows an unrelated new parent', () => {
		expect(isDescendant('node2', 'cluster', edges)).toBe(false);
	});

	test('terminates on a graph that already contains a cycle', () => {
		// A self-edge written by an earlier release must not hang the walk.
		const cyclic = [{ parentId: 'a', childId: 'a' }, { parentId: 'a', childId: 'b' }];
		expect(isDescendant('zzz', 'a', cyclic)).toBe(false);
	});
});
