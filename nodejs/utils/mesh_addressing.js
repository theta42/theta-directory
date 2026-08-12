'use strict';

// Mesh addressing for the theta42 WireGuard cluster.
//
// ONE number identifies a site everywhere: its `ldapServerId`, allocated once
// by the master when the site joins (routes/api_site.js, reserved 1 for the
// master itself) and stable for the life of that site. That same integer is
// its OpenLDAP ServerID, its mesh address, and the second octet of its private
// network -- so joining the directory IS joining the mesh, and there is no
// second allocator to keep in sync.
//
//   172.24.0.<siteId>/32     the gateway's mesh identity
//   10.<siteId>.0.0/16       everything at that site
//
// Inside a site's /16:
//
//   10.<s>.0.1               the gateway, acting as that site's router
//   10.<s>.0.0/24            site services (directory .2, proxy .3, ...)
//   10.<s>.168.0/24          NETMAP shadow of a physical LAN
//   10.<s>.172.0/24          NETMAP shadow of a second physical LAN
//   10.<s>.128.0/17          client devices (laptops, phones, agents)
//
// The shadows exist because every home and office LAN is 192.168.1.0/24 or
// 172.16.0.0/24; NETMAPping each site's LAN into a slot of its own /16 makes
// those ranges globally unique across the cluster without renumbering anyone.
//
// Pure/no I/O so it is cheaply testable, and DELIBERATELY duplicated in
// jump-host's utils/mesh_addressing.js: the two components must agree on this
// math exactly, and both pin it with tests that name the other side, the same
// convention the old MESH_SERVICE_PORT_BASE contract used.

// The mesh gives every site one octet, so 254 is a hard ceiling -- note this
// is far below LDAP's own MAX_LDAP_SERVER_ID (4094). The addressing is the
// binding constraint on how many sites a cluster can have.
const MAX_SITE_ID = 254;
const MIN_SITE_ID = 1;
// Not enforced, but what the design is sized for; crossing it is a signal the
// deployment has outgrown a single flat mesh.
const SOFT_SITE_LIMIT = 32;

const MESH_PREFIX = '172.24.0';

// Shadow slots, as the third octet of the site's /16.
const SHADOW_SLOTS = [168, 172];
// What each shadow slot maps to when the operator has not said otherwise --
// chosen to echo the physical ranges they most often stand in for.
const SHADOW_DEFAULTS = { 168: '192.168.1.0/24', 172: '172.16.0.0/24' };

function assertSiteId(siteId) {
	const id = Number(siteId);
	if (!Number.isInteger(id) || id < MIN_SITE_ID || id > MAX_SITE_ID) {
		throw new Error(`site id must be an integer in [${MIN_SITE_ID}, ${MAX_SITE_ID}], got ${siteId}`);
	}
	return id;
}

/** The gateway's mesh identity address, e.g. 172.24.0.4/32. */
function meshAddress(siteId) {
	return `${MESH_PREFIX}.${assertSiteId(siteId)}/32`;
}

/** Just the IP, no prefix -- what gets stored and displayed. */
function meshIp(siteId) {
	return `${MESH_PREFIX}.${assertSiteId(siteId)}`;
}

/** The site's whole private network, e.g. 10.4.0.0/16. */
function siteCidr(siteId) {
	return `10.${assertSiteId(siteId)}.0.0/16`;
}

/** The gateway's address inside its own site, acting as that site's router. */
function siteGatewayIp(siteId) {
	return `10.${assertSiteId(siteId)}.0.1`;
}

/** Site service addresses: .2 directory, .3 proxy, ... */
function siteServiceIp(siteId, offset = 2) {
	return `10.${assertSiteId(siteId)}.0.${offset}`;
}

/** The client pool, 10.<s>.128.0/17 -- 32766 devices per site. */
function clientPoolCidr(siteId) {
	return `10.${assertSiteId(siteId)}.128.0/17`;
}

/**
 * Nth client address in a site's pool (n starts at 1 => 10.<s>.128.1).
 * A /17 spans third octets 128-255, so the pool is addressed as a flat
 * sequence across that range rather than a single /24.
 */
function clientIp(siteId, n) {
	assertSiteId(siteId);
	const index = Number(n);
	// .0 and .255 in each /24 are avoided: some client stacks and consumer
	// firewalls still treat them as network/broadcast even inside a /17.
	const usablePerOctet = 254;
	const max = 128 * usablePerOctet;
	if (!Number.isInteger(index) || index < 1 || index > max) {
		throw new Error(`client index must be an integer in [1, ${max}], got ${n}`);
	}
	const third = 128 + Math.floor((index - 1) / usablePerOctet);
	const fourth = ((index - 1) % usablePerOctet) + 1;
	return `10.${siteId}.${third}.${fourth}`;
}

/** The shadow /24 for one of a site's physical LANs. */
function shadowCidr(siteId, slot) {
	assertSiteId(siteId);
	if (!SHADOW_SLOTS.includes(Number(slot))) {
		throw new Error(`shadow slot must be one of ${SHADOW_SLOTS.join(', ')}, got ${slot}`);
	}
	return `10.${siteId}.${slot}.0/24`;
}

/**
 * Translate a host on a site's PHYSICAL LAN to its shadow address.
 *
 * This is what makes a site's DNS resolver usable from anywhere in the mesh.
 * Handing a roaming client `DNS = 192.168.1.1` only works while it is
 * physically on that LAN -- over the tunnel what is routed is the shadow
 * range, not the physical one. So the operator configures a LAN IP and this
 * turns it into the address that actually resolves from the mesh.
 *
 * Returns null when the host is not inside the mapped range, so a caller can
 * report a misconfiguration instead of pushing an address that goes nowhere.
 */
function shadowFor(siteId, physicalHost, physicalCidr, slot) {
	assertSiteId(siteId);
	const host = String(physicalHost || '').trim();
	const [base, bits] = String(physicalCidr || '').split('/');
	if (!host || !base || Number(bits) !== 24) return null;

	const hostOctets = host.split('.').map(Number);
	const baseOctets = base.split('.').map(Number);
	if (hostOctets.length !== 4 || baseOctets.length !== 4) return null;
	if (hostOctets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null;
	// Same /24 as the mapped range?
	if (hostOctets[0] !== baseOctets[0] || hostOctets[1] !== baseOctets[1] || hostOctets[2] !== baseOctets[2]) {
		return null;
	}
	return `10.${siteId}.${Number(slot)}.${hostOctets[3]}`;
}

/** Every prefix a peer gateway is allowed to send us traffic for. */
function peerAllowedIps(siteId) {
	return [`${MESH_PREFIX}.${assertSiteId(siteId)}/32`, siteCidr(siteId)];
}

/**
 * The hub's AllowedIPs: the whole mesh as a catch-all, so sites that are not
 * directly peered still reach each other. WireGuard does longest-prefix match,
 * so a direct peer's more specific 10.<n>.0.0/16 automatically wins over this
 * -- there is no prefix subtraction to maintain.
 *
 * NEVER includes 0.0.0.0/0: AllowedIPs is one trie per interface, and a peer
 * claiming the default route steals it from every other peer, which is what
 * makes exit selection impossible on a shared interface. Exits get their own
 * interfaces.
 */
function hubAllowedIps() {
	return ['10.0.0.0/8', '172.24.0.0/16'];
}

module.exports = {
	MAX_SITE_ID, MIN_SITE_ID, SOFT_SITE_LIMIT, MESH_PREFIX, SHADOW_SLOTS, SHADOW_DEFAULTS,
	assertSiteId, meshAddress, meshIp, siteCidr, siteGatewayIp, siteServiceIp,
	clientPoolCidr, clientIp, shadowCidr, shadowFor, peerAllowedIps, hubAllowedIps
};
