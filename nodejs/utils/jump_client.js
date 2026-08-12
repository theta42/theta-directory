'use strict';

// Gateway count for the Directory's Multi-Site & Network Gateway Status modal.
//
// In the mesh-v2 model the roster lives HERE -- the directory is the registry
// (utils/mesh_roster.js allocates siteIds and stores what every gateway
// published about itself). So the "real gateway-to-gateway mesh peer count" is
// just the number of roster sites that have actually published a WireGuard
// identity, computed locally from the MeshSite table. The old service-to-
// service jump-host call (GET /api/mesh/gateways) died with the v2 rewrite,
// which had no such endpoint -- counting a list that can never be fetched was
// the modal's 404.

const { MeshSite } = require('../models/mesh_site');

// Returns { count, note }. count is null (not 0) when the query couldn't run
// at all -- the modal shows a count of gateways it could actually see, not a
// misleading "0" that reads as "you have no mesh peers" when the truth is
// "this isn't wired up yet".
async function getGatewayCount() {
	try {
		const sites = await MeshSite.list();
		const published = sites.filter((s) => s.gatewayPublicKey);
		return { count: published.length, note: 'ok' };
	} catch (err) {
		return { count: null, note: `failed: ${err.message}` };
	}
}

module.exports = { getGatewayCount };
