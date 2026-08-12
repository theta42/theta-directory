'use strict';

// The cluster roster: which sites exist, how to reach their gateways, and
// which of them offer an exit. Gateways pull this and apply it; the directory
// never invents any of it.
//
// Where siteId comes from: it IS the site's OpenLDAP ServerID. The master
// reserves 1 for itself and allocates 2+ to each spoke at join
// (routes/api_site.js), serialized under a lock because a read-then-write
// allocation had already been seen to hand two spokes the same id. Reusing it
// means the mesh has no allocator of its own, and a site cannot be in the
// directory but absent from the mesh.
//
// The one constraint this adds: mesh addressing gives each site a single octet
// (10.<siteId>.0.0/16), so siteId cannot exceed 254 -- far below LDAP's own
// 4094 ceiling. A cluster that outgrows 254 sites has outgrown this
// addressing, not just this table.

const crypto = require('crypto');
const { MeshSite } = require('../models/mesh_site');
const { SiteSpoke } = require('../models/site_spoke');
const siteConfig = require('./site_config');
const { currentSlapdServerId } = require('./ldap_replication');
const { MAX_SITE_ID, SHADOW_DEFAULTS } = require('./mesh_addressing');

const now = () => Math.floor(Date.now() / 1000);

/**
 * This node's own site id.
 *
 * Read from the running slapd config, which is where the join flow writes the
 * id the master handed out -- rather than from a second copy in site.json that
 * could drift from the ServerID actually in use. The master falls back to 1,
 * its reserved id, so a single-site deployment that has never replicated still
 * has a usable mesh identity.
 */
function localSiteId() {
	const fromSlapd = currentSlapdServerId();
	if (fromSlapd) return fromSlapd;
	return siteConfig.get().isMaster ? 1 : null;
}

/** The roster, lowest site id first. */
async function roster() {
	const sites = await MeshSite.list();
	return sites.sort((a, b) => Number(a.siteId) - Number(b.siteId));
}

async function bySiteId(siteId) {
	return (await MeshSite.list({ where: { siteId: Number(siteId) } }))[0] || null;
}

/**
 * Create or update this site's own row.
 *
 * Only ever called for the LOCAL site -- a gateway publishes facts about
 * itself and nothing else, which is what keeps every site an equal peer.
 */
async function publishLocalSite(patch = {}) {
	const siteId = localSiteId();
	if (!siteId) {
		throw Object.assign(
			new Error('this node has no site id yet — it has not joined a master, and is not one'),
			{ status: 409 }
		);
	}
	if (siteId > MAX_SITE_ID) {
		throw Object.assign(
			new Error(`site id ${siteId} is beyond the mesh ceiling of ${MAX_SITE_ID}; this cluster has outgrown the addressing`),
			{ status: 409 }
		);
	}

	const cfg = siteConfig.get();
	const existing = await bySiteId(siteId);
	const fields = {
		slug: patch.slug || (existing && existing.slug) || cfg.siteSlug || '',
		name: patch.name !== undefined ? patch.name : (existing ? existing.name : cfg.siteSlug || ''),
		publishedAt: now(),
		lastSeenAt: now()
	};
	// Only overwrite gateway-published fields that were actually supplied, so a
	// partial publish (say, a liveness ping) cannot blank out the site's LAN
	// config.
	for (const key of ['gatewayPublicKey', 'gatewayEndpoint', 'exitOpen', 'country', 'city', 'lan168', 'lan172', 'dnsHost']) {
		if (patch[key] !== undefined) fields[key] = patch[key];
	}

	if (existing) {
		await existing.update(fields);
		return existing;
	}
	return MeshSite.create({
		id: crypto.randomUUID(),
		siteId,
		isHub: siteId === 1 && !(await anyHub()),
		lan168: SHADOW_DEFAULTS[168],
		lan172: SHADOW_DEFAULTS[172],
		...fields
	});
}

async function anyHub() {
	return (await MeshSite.list({ where: { isHub: true } })).length > 0;
}

/**
 * Make sure every site the master knows about has a roster row, even before
 * its gateway has published anything.
 *
 * Without this a freshly-joined site is invisible to the rest of the cluster
 * until someone starts its gateway -- and the operator has no row to configure
 * in the meantime. Rows created here carry identity only; every network field
 * stays empty until that site's own gateway fills it in.
 */
async function syncFromSpokes() {
	if (!siteConfig.get().isMaster) return { created: 0 };
	const spokes = await SiteSpoke.list();
	let created = 0;
	for (const spoke of spokes) {
		if (!spoke.ldapServerId || spoke.ldapServerId > MAX_SITE_ID) continue;
		if (await bySiteId(spoke.ldapServerId)) continue;
		await MeshSite.create({
			id: crypto.randomUUID(),
			siteId: spoke.ldapServerId,
			slug: spoke.siteSlug || '',
			name: spoke.siteSlug || '',
			lan168: SHADOW_DEFAULTS[168],
			lan172: SHADOW_DEFAULTS[172],
			publishedAt: 0,
			lastSeenAt: 0
		});
		created++;
	}
	return { created };
}

/** The catch-all site, or null when the operator has not picked one. */
async function hub() {
	return (await MeshSite.list({ where: { isHub: true } }))[0] || null;
}

/**
 * Designate the hub. Exactly one, cleared everywhere else first -- two sites
 * both claiming 10.0.0.0/8 would each be a catch-all for traffic the other
 * expects to carry.
 */
async function setHub(siteId) {
	const target = await bySiteId(siteId);
	if (!target) throw Object.assign(new Error(`no site with id ${siteId}`), { status: 404 });
	for (const site of await MeshSite.list()) {
		if (site.isHub && Number(site.siteId) !== Number(siteId)) await site.update({ isHub: false });
	}
	await target.update({ isHub: true });
	return target;
}

module.exports = {
	localSiteId, roster, bySiteId, publishLocalSite, syncFromSpokes, hub, setHub
};
