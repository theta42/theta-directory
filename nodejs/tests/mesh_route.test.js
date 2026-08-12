'use strict';

// Reaching a peer site's directory over the mesh.
//
// This was once a workaround for WireGuard being stuck inside the gateway
// CONTAINER's namespace -- a userspace relay on a port derived from the site
// index. The gateway is a real router now, so a peer's directory is just an
// address, and the derived-port contract the two components had to agree on
// separately is gone.

const { siteIdFrom, meshServiceTarget, DIRECTORY_PORT } = require('../utils/mesh_route');

describe('siteIdFrom', () => {
	test('reads the site id from a gateway mesh address', () => {
		expect(siteIdFrom('172.24.0.1')).toBe(1);
		expect(siteIdFrom('172.24.0.42')).toBe(42);
		expect(siteIdFrom('172.24.0.254')).toBe(254);
	});

	// A caller may hold either form -- the gateway's identity or something
	// inside that site's network. Both name the same site.
	test('reads the site id from any address inside a site network', () => {
		expect(siteIdFrom('10.5.0.2')).toBe(5);
		expect(siteIdFrom('10.5.128.17')).toBe(5);
		expect(siteIdFrom('10.5.168.53')).toBe(5);
	});

	test('rejects addresses that are not mesh addresses', () => {
		expect(siteIdFrom('192.168.1.10')).toBe(null);
		expect(siteIdFrom('172.24.1.1')).toBe(null); // the OLD scheme
		expect(siteIdFrom('')).toBe(null);
		expect(siteIdFrom(null)).toBe(null);
		expect(siteIdFrom('not an ip')).toBe(null);
	});

	// One octet per site is the hard ceiling; ids outside it have no address.
	test('rejects site ids outside the addressable range', () => {
		expect(siteIdFrom('172.24.0.0')).toBe(null);
		expect(siteIdFrom('172.24.0.255')).toBe(null);
		expect(siteIdFrom('10.0.0.2')).toBe(null);
		expect(siteIdFrom('10.255.0.2')).toBe(null);
	});
});

describe('meshServiceTarget', () => {
	test('a peer directory is that site .0.2, no derived port', () => {
		expect(meshServiceTarget('172.24.0.5')).toEqual({ host: '10.5.0.2', port: 3001, siteId: 5 });
		expect(DIRECTORY_PORT).toBe(3001);
	});

	test('the same answer whichever form of the address is given', () => {
		expect(meshServiceTarget('10.5.0.1')).toEqual(meshServiceTarget('172.24.0.5'));
	});

	// Callers keep a public-endpoint fallback, so a non-mesh address must
	// report null rather than produce something that cannot be dialled.
	test('a non-mesh address has no target', () => {
		expect(meshServiceTarget('203.0.113.9')).toBe(null);
		expect(meshServiceTarget('')).toBe(null);
	});

	// The old scheme put the site index in the THIRD octet and needed
	// JUMP_INTERNAL_URL to find the local gateway's relay port. Neither is
	// true any more; an old-format address must not silently resolve.
	test('an address in the retired scheme is not accepted', () => {
		expect(meshServiceTarget('172.24.3.1')).toBe(null);
	});
});
