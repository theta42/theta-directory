'use strict';

// Renders the wg config a client device actually runs -- a laptop under
// theta-agent, or a phone scanning a QR code.
//
// Three things here are easy to get wrong and are therefore decided centrally
// rather than left to whoever generates a config:
//
//  1. DNS is pushed as the SHADOW address, never the physical LAN IP.
//  2. MTU is clamped, because mesh-then-exit is WireGuard inside WireGuard.
//  3. `Table` is never set to off on a client -- only site gateways do manual
//     routing; a client wants wg-quick's normal AllowedIPs-driven routes.

const { siteCidr, shadowFor, SHADOW_SLOTS } = require('./mesh_addressing');

// WireGuard's own overhead is 60 bytes on IPv4 (20 IP + 8 UDP + 32 WG), so the
// usual single-hop MTU is 1420 on a 1500 path. But traffic that crosses the
// mesh and then leaves through an exit is encapsulated TWICE, and a client
// sized for one hop will blackhole large packets on the second -- the classic
// "SSH works, HTTPS hangs" failure, where small packets pass and a TLS
// handshake never completes.
//
// 1380 leaves room for the second encapsulation and still clears the 1280
// IPv6 minimum. It is not tuned per path deliberately: a value that is
// slightly small costs a little throughput, while one that is slightly large
// costs a support call.
const CLIENT_MTU = 1380;

/**
 * Which address to hand a client as its DNS server.
 *
 * The site's resolver is configured as a host on one of its physical LANs
 * (192.168.1.1, say). Pushing that verbatim produces a config that resolves
 * only while the device is sitting on that LAN: over the tunnel, what is
 * routed is the shadow range, not the physical one. So translate it.
 *
 * Returns null when the configured resolver is not inside either mapped LAN,
 * so the caller can leave DNS unset rather than push an address that silently
 * goes nowhere.
 */
function resolverFor(site) {
	if (!site || !site.dnsHost) return null;
	for (const slot of SHADOW_SLOTS) {
		const lan = slot === 168 ? site.lan168 : site.lan172;
		const shadow = shadowFor(site.siteId, site.dnsHost, lan, slot);
		if (shadow) return shadow;
	}
	return null;
}

/**
 * What a client is allowed to route through the tunnel.
 *
 * - With no exit: just the mesh. Normal internet traffic keeps using whatever
 *   local connection the device already has (split tunnel).
 * - With an exit: everything. The gateway then decides, per client, which exit
 *   interface carries it -- the client is not told which exit it is using and
 *   does not need reconfiguring when that changes.
 */
function allowedIpsFor({ hasExit }) {
	if (hasExit) return ['0.0.0.0/0', '::/0'];
	return ['10.0.0.0/8', '172.24.0.0/16'];
}

/**
 * Build a client config.
 *
 * @param {object} client   MeshClient row (assignedIp, exitSiteId)
 * @param {object} site     that client's MeshSite row (its home site)
 * @param {string} privateKey  the one-time private key, or null when the
 *                             device generated its own and will fill this in
 * @returns {string}
 */
function renderClientConf({ client, site, privateKey }) {
	const hasExit = client.exitSiteId !== null && client.exitSiteId !== undefined && client.exitSiteId !== '';
	const dns = resolverFor(site);

	const lines = [
		`# ${client.name} — site ${site.siteId}${site.slug ? ` (${site.slug})` : ''}`,
		'[Interface]',
		// A device that generated its own keypair fills this in locally; the
		// placeholder makes an unfilled config fail loudly rather than
		// half-work.
		`PrivateKey = ${privateKey || '<generated on this device>'}`,
		`Address = ${client.assignedIp}/32`,
		`MTU = ${CLIENT_MTU}`
	];
	if (dns) lines.push(`DNS = ${dns}`);

	lines.push('');
	lines.push(`# ${site.slug || 'site ' + site.siteId} gateway`);
	lines.push('[Peer]');
	lines.push(`PublicKey = ${site.gatewayPublicKey}`);
	lines.push(`AllowedIPs = ${allowedIpsFor({ hasExit }).join(', ')}`);
	if (site.gatewayEndpoint) lines.push(`Endpoint = ${site.gatewayEndpoint}`);
	// Clients are behind NAT essentially always; without a keepalive the
	// gateway loses the return path as soon as the NAT mapping expires and the
	// device becomes unreachable while still believing it is connected.
	lines.push('PersistentKeepalive = 25');

	return lines.join('\n') + '\n';
}

/**
 * The routes theta-agent should install alongside the tunnel, as structured
 * data rather than shell -- the agent applies them per-platform.
 *
 * The site's own /16 is on-link through the tunnel; the rest of the mesh goes
 * via the gateway. Handing these down rather than letting the agent derive
 * them keeps the addressing scheme in one place.
 */
function clientRoutes({ client, site }) {
	return [
		{ destination: siteCidr(site.siteId), dev: true, note: "this device's own site" },
		{ destination: '10.0.0.0/8', via: `10.${site.siteId}.0.1`, note: 'the rest of the mesh, via the site gateway' },
		{ destination: '172.24.0.0/16', via: `10.${site.siteId}.0.1`, note: 'gateway mesh addresses' }
	];
}

module.exports = { renderClientConf, clientRoutes, resolverFor, allowedIpsFor, CLIENT_MTU };
