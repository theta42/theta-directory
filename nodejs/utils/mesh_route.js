'use strict';

// How to reach a peer site's directory over the mesh.
//
// This used to be a workaround. WireGuard lived inside the jump-host
// CONTAINER's network namespace, so a peer's mesh address was unreachable from
// here and from theta-proxy, and the only way through was a userspace relay on
// the local gateway listening on a port derived from the site index. That
// whole mechanism (jump-host's services/mesh_forwarder.js) is gone: the
// gateway is a router now, the mesh is really routed, and a peer site's
// directory is simply an address.
//
// Addressing (must match utils/mesh_addressing.js and jump-host's copy):
//
//   172.24.0.<siteId>   the peer GATEWAY -- an identifier, not a service
//   10.<siteId>.0.2     that site's directory
//
// A caller that knows either form knows the site id, and the site id is all
// that is needed. Nothing is stored and nothing is derived from a port scheme
// the two components have to agree on separately.

const { MAX_SITE_ID, MIN_SITE_ID, siteServiceIp } = require('./mesh_addressing');

// The directory's port, the same at every site.
const DIRECTORY_PORT = 3001;

/**
 * Pull the site id out of any mesh address -- either a gateway identity
 * (172.24.0.<id>) or an address inside a site's own network (10.<id>.x.y).
 * Returns null for anything else, so a caller falls back rather than dialling
 * a guess.
 */
function siteIdFrom(address) {
	const value = String(address || '').trim();

	const gateway = /^172\.24\.0\.(\d{1,3})$/.exec(value);
	if (gateway) return inRange(Number(gateway[1]));

	const inside = /^10\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(value);
	if (inside) return inRange(Number(inside[1]));

	return null;
}

function inRange(id) {
	if (!Number.isInteger(id) || id < MIN_SITE_ID || id > MAX_SITE_ID) return null;
	return id;
}

/**
 * Where a peer site's directory answers, or null when the address given is not
 * a mesh address at all.
 *
 * Reaching it requires this container to have a route for 10.0.0.0/8 via the
 * local gateway -- see docs/mesh.md. Callers keep a public-endpoint fallback
 * (utils/site_replicate.js) precisely so that a deployment without that route
 * still replicates, just over the internet rather than the tunnel.
 */
function meshServiceTarget(address) {
	const siteId = siteIdFrom(address);
	if (siteId === null) return null;
	return { host: siteServiceIp(siteId), port: DIRECTORY_PORT, siteId };
}

module.exports = { siteIdFrom, meshServiceTarget, DIRECTORY_PORT };
