'use strict';

const { Model } = require('@simpleworkjs/orm');

// A client device on the mesh: a laptop running theta-agent, a phone with the
// WireGuard app, a tablet. One row per device, owned by a directory user.
//
// A client belongs to the site it enrolled at and takes an address from that
// site's pool (10.<siteId>.128.0/17), so its address is globally routable
// across the cluster -- every site routes 10.<n>.0.0/16 to site n's gateway.
//
// PRIVATE KEYS ARE NEVER STORED. Either the device generates its own keypair
// and sends up only the public key (what theta-agent does), or the server
// generates one, renders it into a config once, and forgets it. A key that is
// not kept cannot leak from here.
class MeshClient extends Model {
	static fields = {
		id: { type: 'uuid', primaryKey: true },

		// Directory uid of the owner. Any user may enrol their own devices.
		uid: { type: 'string', isRequired: true },
		name: { type: 'string', isRequired: true },

		// Site this device enrolled at, and its address inside that site's
		// client pool. Both fixed for the life of the row: the address is what
		// other people's ACLs and DNS entries point at.
		siteId: { type: 'integer', isRequired: true },
		assignedIp: { type: 'string', isRequired: true, unique: true },

		publicKey: { type: 'string', isRequired: true, unique: true },

		// Which site's internet exit this device uses. Empty = local breakout
		// at its own site. Applied as `ip rule from <assignedIp>/32 lookup
		// <exit>` on the gateway, so changing it rewrites ONE routing rule --
		// the device's config never changes and it does not reconnect. That is
		// what makes a tray-menu exit picker possible.
		exitSiteId: { type: 'integer' },

		// 'agent' = enrolled by theta-agent, which generated its own keypair.
		// 'manual' = created in the UI, server-generated key shown once.
		source: { type: 'string', default: 'manual' },

		createdAt: { type: 'integer' },
		lastSeenAt: { type: 'integer' }
	};
}

// Which exits a given user is allowed to choose. An admin picks explicitly --
// a site being marked `exitOpen` only means it is WILLING to carry traffic,
// never that everyone may use it.
//
// Deliberately a separate row per (uid, siteId) rather than a list column: it
// is the shape a future tag-based grant system would produce anyway, so
// replacing the admin-picks model later does not require touching any of the
// WireGuard code that reads it.
class MeshExitGrant extends Model {
	static fields = {
		id: { type: 'uuid', primaryKey: true },
		uid: { type: 'string', isRequired: true },
		siteId: { type: 'integer', isRequired: true },
		grantedBy: { type: 'string' },
		createdAt: { type: 'integer' }
	};
}

module.exports = { MeshClient, MeshExitGrant };
