'use strict';

const { Model } = require('@simpleworkjs/orm');

// One row per site in the WireGuard cluster -- the roster every gateway pulls
// so it knows who else exists, how to reach them, and which of them offer an
// exit.
//
// OWNERSHIP: each gateway is authoritative for its OWN row and nothing else.
// It publishes what it knows about itself (public key, endpoint, LAN, DNS,
// whether it offers an exit) and the directory distributes that to the rest of
// the cluster. The directory never invents WireGuard config; it is the
// registry and the propagation bus. That keeps every gateway an equal peer,
// with no site subject to another site's writes -- so a partition cannot
// corrupt anyone's network config.
//
// The ONE thing the directory owns is `siteId`, because it is the only value
// that must be unique across the whole cluster. It is not allocated here: it
// IS the site's `ldapServerId`, already assigned by the master at join time
// (routes/api_site.js), with 1 reserved for the master. One number, one
// allocator, and joining the directory is joining the mesh.
class MeshSite extends Model {
	static fields = {
		id: { type: 'uuid', primaryKey: true },

		// = SiteSpoke.ldapServerId, or 1 for the master. Drives the site's mesh
		// address (172.24.0.<siteId>) and its network (10.<siteId>.0.0/16),
		// so it can never be reassigned while the site is live.
		siteId: { type: 'integer', isRequired: true, unique: true },
		slug: { type: 'string' },
		name: { type: 'string' },

		// --- published by that site's own gateway ---------------------------
		// The gateway's WireGuard public key and the host:port peers dial to
		// reach it. Empty endpoint = no inbound (the site can still reach out,
		// and other sites reach it through the hub).
		gatewayPublicKey: { type: 'string' },
		gatewayEndpoint: { type: 'string' },

		// A SECOND public key, used only by this gateway's exit interfaces.
		// Separate because a remote keeps one endpoint and one session per peer
		// key: if a gateway's exit interface presented the same key as its mesh
		// interface, the remote would see one peer whose endpoint flapped
		// between them and the two would invalidate each other's session.
		gatewayExitPublicKey: { type: 'string' },

		// The hub carries 10.0.0.0/8 as a catch-all so sites that are not
		// directly peered still reach each other. Configurable rather than
		// implied by "is the master": the natural hub is a cheap always-up VPS,
		// which is not necessarily where the master directory lives.
		isHub: { type: 'boolean', default: false },

		// --- exit node -------------------------------------------------------
		// Whether this site offers itself as an internet exit at all.
		//
		// Defaults TRUE: a site that joined the mesh has a gateway with a
		// default route, so it can carry traffic, and every site being a usable
		// exit is the behaviour we want. It used to default false and be paired
		// with a mandatory per-user MeshExitGrant -- two closed gates, which
		// left a stock deployment with no usable exit anywhere. Set it false on
		// a specific site to take that site out of the exit pool (a metered
		// link, say); grants still exist for handing one user an exit that is
		// not open to everyone.
		exitOpen: { type: 'boolean', default: true },
		// Shown in the agent's tray picker next to a flag.
		country: { type: 'string' },
		city: { type: 'string' },

		// --- physical LAN + shadows -----------------------------------------
		// The real LANs behind this gateway and the shadow /24s they are
		// NETMAPped into (10.<s>.168.0/24 and 10.<s>.172.0/24). Configurable
		// because a site on 192.168.50.0/24 still needs a working shadow.
		lan168: { type: 'string' },
		lan172: { type: 'string' },

		// The site's resolver, as a host on one of the LANs above. Pushed to
		// clients translated into its SHADOW address -- handing out the
		// physical IP would only resolve while the client is on that LAN.
		dnsHost: { type: 'string' },

		// --- liveness --------------------------------------------------------
		publishedAt: { type: 'integer' },
		lastSeenAt: { type: 'integer' }
	};

	// The roster is read by every gateway in the cluster and rendered in the
	// UI; nothing here is secret (public keys and endpoints are meant to be
	// shared), but keep an explicit projection so a future private field
	// cannot leak by default.
	toPublic() {
		const data = this.toJSON ? this.toJSON() : { ...this };
		return data;
	}
}

module.exports = { MeshSite };
