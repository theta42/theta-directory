'use strict';

// How to actually REACH a peer site over the gateway mesh.
//
// A spoke registers the mesh IP its gateway reports (172.24.<idx>.1). That
// address is real, but it exists only inside the peer GATEWAY's network
// namespace -- WireGuard runs in the jump-host container. Nothing else at
// either site can route to it: this app and theta-proxy sit on the docker
// bridge, which has no path into the mesh subnet, and nothing at the far end
// was listening on :3001 anyway (the gateway serves :3002; the directory is a
// different container).
//
// So a mesh IP is not a dial-able address from here. It is an IDENTIFIER --
// the octet in it is the peer's mesh index -- and the dial-able address is the
// LOCAL gateway's per-peer forwarding port (jump-host's
// services/mesh_forwarder.js), which bridges into the tunnel and out to that
// site's directory on the other side:
//
//   this app -> jump-host:<30000+peerIdx> ==wg tunnel==> 172.24.<peerIdx>.1:3001 -> that site's directory
//
// The port is derived from the index rather than stored, so there is no new
// field to keep in sync between the two components and no discovery step: a
// caller that has the mesh IP already has everything it needs. Both ends must
// agree on the base -- keep this constant and jump-host's
// MESH_SERVICE_PORT_BASE together.

const MESH_SERVICE_PORT_BASE = 30000;
const MESH_SUBNET_PREFIX = '172.24';

// 172.24.<idx>.1 -> idx. Returns null for anything that isn't a mesh address,
// so a caller can fall back rather than dial a guess.
function meshIndexFrom(meshIp) {
	const m = new RegExp(`^${MESH_SUBNET_PREFIX.replace('.', '\\.')}\\.(\\d{1,3})\\.\\d{1,3}$`).exec(String(meshIp || '').trim());
	if (!m) return null;
	const idx = Number(m[1]);
	if (!Number.isInteger(idx) || idx < 1 || idx > 254) return null;
	return idx;
}

function meshServicePort(meshIndex) {
	return MESH_SERVICE_PORT_BASE + Number(meshIndex);
}

// The local gateway's host:port that forwards to `meshIp`'s site, or null when
// this deployment has no gateway configured or the IP isn't a mesh address.
// Host comes from the same JUMP_INTERNAL_URL utils/jump_client.js already
// uses, so there is no second place to configure the gateway.
function meshServiceTarget(meshIp) {
	const idx = meshIndexFrom(meshIp);
	if (idx === null) return null;

	const internal = process.env.JUMP_INTERNAL_URL || '';
	let host;
	try {
		host = internal ? new URL(internal).hostname : '';
	} catch (e) {
		host = '';
	}
	if (!host) return null;

	return { host, port: meshServicePort(idx), meshIndex: idx };
}

module.exports = {
	meshIndexFrom, meshServicePort, meshServiceTarget,
	MESH_SERVICE_PORT_BASE, MESH_SUBNET_PREFIX
};
