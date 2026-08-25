'use strict';

// The addressing contract for the whole cluster. jump-host pins the same
// numbers in its own utils/mesh_addressing.js and test/unit/mesh_addressing
// .test.js -- if either side drifts, gateways build peers for prefixes the
// other never routes, and the failure shows up as "the tunnel is up but
// nothing crosses it".

const mesh = require('../utils/mesh_addressing');
const { renderClientConf, resolverFor, allowedIpsFor, CLIENT_MTU } = require('../utils/mesh_client_conf');

test('a site id maps to one mesh address and one /16', () => {
	expect(mesh.meshAddress(4)).toBe('172.24.0.4/32');
	expect(mesh.meshIp(4)).toBe('172.24.0.4');
	expect(mesh.siteCidr(4)).toBe('10.4.0.0/16');
	expect(mesh.siteGatewayIp(4)).toBe('10.4.0.1');
	expect(mesh.siteServiceIp(4)).toBe('10.4.0.2');
});

// One octet per site is the binding constraint -- LDAP itself allows 4094
// ServerIDs, but an id above 254 has no address.
test('site ids are limited to a single octet', () => {
	expect(mesh.MAX_SITE_ID).toBe(254);
	expect(() => mesh.meshAddress(255)).toThrow(/site id must be an integer/);
	expect(() => mesh.meshAddress(0)).toThrow(/site id must be an integer/);
	expect(() => mesh.siteCidr('four')).toThrow(/site id must be an integer/);
});

test('a peer gateway is allowed exactly its own /32 and its site /16', () => {
	expect(mesh.peerAllowedIps(6)).toEqual(['172.24.0.6/32', '10.6.0.0/16']);
});

// This is the bug that made multi-exit impossible in the hand-written config
// this replaces: AllowedIPs is one trie per interface, so a peer claiming the
// default route takes it from every other peer. The hub must never claim it.
test('the hub catch-all never includes a default route', () => {
	const hub = mesh.hubAllowedIps();
	expect(hub).toEqual(['10.0.0.0/8', '172.24.0.0/16']);
	expect(!hub.includes('0.0.0.0/0')).toBeTruthy();
	expect(!hub.includes('::/0')).toBeTruthy();
});

test('the client pool spans the upper half of a site /16', () => {
	expect(mesh.clientPoolCidr(2)).toBe('10.2.128.0/17');
	expect(mesh.clientIp(2, 1)).toBe('10.2.128.1');
	expect(mesh.clientIp(2, 254)).toBe('10.2.128.254');
	// Rolls into the next third octet rather than emitting .255 or .0, which
	// some consumer stacks still treat as broadcast/network inside a /17.
	expect(mesh.clientIp(2, 255)).toBe('10.2.129.1');
	expect(mesh.clientIp(2, 128 * 254)).toBe('10.2.255.254');
	expect(() => mesh.clientIp(2, 128 * 254 + 1)).toThrow(/client index must be/);
});

test('client addresses never land on .0 or .255', () => {
	for (let i = 1; i <= 1200; i++) {
		const last = Number(mesh.clientIp(7, i).split('.')[3]);
		expect(last >= 1 && last <= 254).toBeTruthy();
	}
});

test('shadow slots map a physical LAN into the site /16', () => {
	expect(mesh.shadowCidr(3, 168)).toBe('10.3.168.0/24');
	expect(mesh.shadowCidr(3, 172)).toBe('10.3.172.0/24');
	expect(() => mesh.shadowCidr(3, 99)).toThrow(/shadow slot must be/);
});

test('a LAN host translates to its shadow address, preserving the last octet', () => {
	expect(mesh.shadowFor(3, '192.168.1.1', '192.168.1.0/24', 168)).toBe('10.3.168.1');
	expect(mesh.shadowFor(3, '192.168.1.53', '192.168.1.0/24', 168)).toBe('10.3.168.53');
	// A site on a different LAN still gets a working shadow -- the mapping is
	// configurable precisely so this works.
	expect(mesh.shadowFor(9, '192.168.50.10', '192.168.50.0/24', 168)).toBe('10.9.168.10');
	expect(mesh.shadowFor(9, '172.16.0.5', '172.16.0.0/24', 172)).toBe('10.9.172.5');
});

test('a host outside the mapped range has no shadow', () => {
	// Better to return null and leave DNS unset than to push an address that
	// silently resolves nothing.
	expect(mesh.shadowFor(3, '10.9.9.9', '192.168.1.0/24', 168)).toBe(null);
	expect(mesh.shadowFor(3, '', '192.168.1.0/24', 168)).toBe(null);
	expect(mesh.shadowFor(3, '192.168.1.1', '', 168)).toBe(null);
	// Only /24 shadows exist; a wider LAN cannot be mapped into one slot.
	expect(mesh.shadowFor(3, '192.168.1.1', '192.168.0.0/16', 168)).toBe(null);
});

// ── client config ───────────────────────────────────────────────────────────

const site = {
	siteId: 2, slug: 'site-home',
	gatewayPublicKey: 'Z2F0ZXdheS1wdWJsaWMta2V5LTAwMDAwMDAwMDAwMDA=',
	gatewayEndpoint: 'gw.example.com:51820',
	lan168: '192.168.1.0/24', lan172: '172.16.0.0/24', dnsHost: '192.168.1.1'
};
const client = { name: 'laptop', assignedIp: '10.2.128.5', exitSiteId: null };

test('DNS is pushed as the shadow address, not the physical LAN IP', () => {
	// The whole point: 192.168.1.1 only resolves while on that LAN.
	expect(resolverFor(site)).toBe('10.2.168.1');
	expect(renderClientConf({ client, site, privateKey: 'k' }).includes('DNS = 10.2.168.1')).toBeTruthy();
});

test('a resolver outside the mapped LANs leaves DNS unset', () => {
	const odd = { ...site, dnsHost: '8.8.8.8' };
	expect(resolverFor(odd)).toBe(null);
	expect(!renderClientConf({ client, site: odd, privateKey: 'k' }).includes('DNS =')).toBeTruthy();
});

test('a manual/QR client with no exit routes only the mesh', () => {
	// `client` has no agentId: a phone handed a config once, with nothing on
	// it managing the tunnel. Split tunnel is right there -- a config that
	// captured all its traffic the moment it was scanned would be a surprise.
	expect(allowedIpsFor({ hasExit: false })).toEqual(['10.0.0.0/8', '172.24.0.0/16']);
	const conf = renderClientConf({ client, site, privateKey: 'k' });
	expect(conf.includes('AllowedIPs = 10.0.0.0/8, 172.24.0.0/16')).toBeTruthy();
	expect(!conf.includes('0.0.0.0/0')).toBeTruthy();
});

// The regression: an agent-managed laptop with no exit selected -- which is
// EVERY device's starting state -- brought up a tunnel that carried the mesh
// ranges and left everything else on the network it was sitting on. Auto-VPN
// fired, the tray went blue, and nothing was protected.
test('an agent-managed device is full tunnel even with no exit selected', () => {
	expect(allowedIpsFor({ hasExit: false, agentManaged: true })).toEqual(['0.0.0.0/0', '::/0']);
	const laptop = { ...client, agentId: 'agent-1' };
	const conf = renderClientConf({ client: laptop, site, privateKey: null });
	expect(conf.includes('AllowedIPs = 0.0.0.0/0, ::/0')).toBeTruthy();
	expect(!conf.includes('10.0.0.0/8, 172.24.0.0/16')).toBeTruthy();
});

test('an agent-managed device gets the same routes whichever exit it is on', () => {
	const laptop = { ...client, agentId: 'agent-1' };
	const none = renderClientConf({ client: laptop, site, privateKey: null });
	const own = renderClientConf({ client: { ...laptop, exitSiteId: 2 }, site, privateKey: null });
	const remote = renderClientConf({ client: { ...laptop, exitSiteId: 7 }, site, privateKey: null });
	// The gateway decides where the traffic leaves; the device is not
	// reconfigured for it. WHETHER the tunnel is up is the agent's call.
	expect(own).toBe(none);
	expect(remote).toBe(none);
});

test('a client with an exit routes everything and is told nothing about which exit', () => {
	const viaFive = renderClientConf({ client: { ...client, exitSiteId: 5 }, site, privateKey: 'k' });
	expect(viaFive.includes('AllowedIPs = 0.0.0.0/0, ::/0')).toBeTruthy();

	// Exit selection is a routing rule on the gateway, so switching exits must
	// produce a byte-identical config -- that is what lets the tray change it
	// without the device reconnecting or being re-provisioned.
	const viaSeven = renderClientConf({ client: { ...client, exitSiteId: 7 }, site, privateKey: 'k' });
	expect(viaSeven).toBe(viaFive);
});

test('MTU is clamped for WireGuard-inside-WireGuard', () => {
	expect(CLIENT_MTU).toBe(1380);
	expect(renderClientConf({ client, site, privateKey: 'k' }).includes('MTU = 1380')).toBeTruthy();
});

test('a client config never turns off wg-quick routing', () => {
	// Table = off belongs on site gateways, which do their own routing. A
	// client that got it would build a tunnel and route nothing through it.
	expect(!renderClientConf({ client, site, privateKey: 'k' }).includes('Table')).toBeTruthy();
});

test('clients always get a keepalive, since they are behind NAT', () => {
	expect(renderClientConf({ client, site, privateKey: 'k' }).includes('PersistentKeepalive = 25')).toBeTruthy();
});

test('a device that generated its own key gets a placeholder, not a blank', () => {
	const conf = renderClientConf({ client, site, privateKey: null });
	expect(conf.includes('PrivateKey = <generated on this device>')).toBeTruthy();
});
