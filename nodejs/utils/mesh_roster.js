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
const { fetchWithAuthRedirect } = require('./fetch_with_auth_redirect');

const now = () => Math.floor(Date.now() / 1000);

/**
 * This node's own site id.
 *
 * Order matters:
 *
 *  1. What the master ASSIGNED this node (persisted at registration, and
 *     re-persisted every time replication config is applied).
 *  2. The ServerID in the slapd.conf seed.
 *  3. 1, the master's reserved id, so a single-site deployment that has never
 *     replicated still has a usable mesh identity.
 *
 * This used to read the seed FIRST. The seed only carries whatever
 * LDAP_SERVER_ID happened to be in the container environment at boot, and a
 * spoke does not get that value into its environment until setup.sh has been
 * re-run after the join -- while slapd's live cn=config was already converged
 * on the assigned id by utils/ldap_reconcile.js. So between joining and the
 * next setup.sh run, a freshly-joined spoke published its gateway under the
 * wrong site id (usually 1, the master's).
 */
function localSiteId() {
	const cfg = siteConfig.get();
	if (cfg.ldapServerId) return Number(cfg.ldapServerId);
	const fromSlapd = currentSlapdServerId();
	if (fromSlapd) return fromSlapd;
	return cfg.isMaster ? 1 : null;
}

/** The roster, lowest site id first. */
async function roster() {
	const sites = await MeshSite.list();
	return sites.sort((a, b) => Number(a.siteId) - Number(b.siteId));
}

/**
 * The roster row as a NON-admin may see it: identity and addressing for the
 * mesh page, but not the WireGuard keys and dial endpoints that would turn the
 * roster into a full network map (and that only gateways and admins need).
 * Kept as an explicit projection on the model's row so a future added field
 * cannot leak by default.
 */
function toPublicSafe(site) {
	const data = site.toJSON ? site.toJSON() : { ...site };
	const { gatewayPublicKey, gatewayEndpoint, gatewayExitPublicKey, ...rest } = data;
	return {
		...rest,
		// Non-admins still get to see whether a site is on the wire, just not
		// the key that proves it.
		gatewayPublished: !!gatewayPublicKey
	};
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
	for (const key of ['gatewayPublicKey', 'gatewayEndpoint', 'gatewayExitPublicKey', 'exitOpen', 'country', 'city', 'lan168', 'lan172', 'dnsHost']) {
		if (patch[key] !== undefined) fields[key] = patch[key];
	}

	// dnsHostDetected is a SUGGESTION, not a publish: the gateway sends what it
	// found on the site LAN, and it is taken only while nobody has said
	// otherwise. It has to be a separate field from dnsHost because reconcile
	// runs on a timer -- a gateway that published its guess as dnsHost would
	// overwrite the admin's answer every few minutes, which is worse than
	// having no default at all.
	if (patch.dnsHostDetected && fields.dnsHost === undefined && !(existing && existing.dnsHost)) {
		fields.dnsHost = patch.dnsHostDetected;
	}

	if (existing) {
		await existing.update(fields);
		await pushSelfToMaster(existing);
		return existing;
	}
	const created = await MeshSite.create({
		id: crypto.randomUUID(),
		siteId,
		isHub: siteId === 1 && !(await anyHub()),
		lan168: SHADOW_DEFAULTS[168],
		lan172: SHADOW_DEFAULTS[172],
		...fields
	});
	await pushSelfToMaster(created);
	return created;
}

/**
 * Tell the master what this site's gateway published.
 *
 * Replication only flows master -> spoke, so without this a spoke's gateway
 * key and endpoint never leave the spoke: the master would not have them, and
 * neither would any other site, so nothing could ever build a peer for it.
 *
 * Reuses POST /api/site/spokes -- the channel a spoke already has to the
 * master, authenticated with the join key it already holds -- rather than
 * inventing a second credential and a second endpoint. That route is
 * upsert-by-endpoint and preserves the existing pushToken, so calling it again
 * is safe.
 *
 * Best-effort and never throws: a gateway must still configure itself from
 * what it knows when the master is unreachable.
 */
async function pushSelfToMaster(site) {
	const cfg = siteConfig.get();
	if (cfg.isMaster) return { pushed: false, reason: 'this node is the master' };
	if (!cfg.masterUrl || !cfg.masterJoinKey || !cfg.selfUrl) {
		return { pushed: false, reason: 'no master registration details on this node' };
	}
	if (!site.gatewayPublicKey) return { pushed: false, reason: 'nothing published yet' };

	try {
		const resp = await fetchWithAuthRedirect(String(cfg.masterUrl).replace(/\/+$/, '') + '/api/site/spokes', {
			method: 'POST',
			headers: { Authorization: 'Bearer ' + cfg.masterJoinKey, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				endpoint: cfg.selfUrl,
				siteSlug: site.slug || cfg.siteSlug,
				gatewayPublicKey: site.gatewayPublicKey,
				gatewayEndpoint: site.gatewayEndpoint || '',
				gatewayExitPublicKey: site.gatewayExitPublicKey || '',
				exitOpen: !!site.exitOpen,
				country: site.country || '',
				city: site.city || '',
				lan168: site.lan168 || '',
				lan172: site.lan172 || '',
				dnsHost: site.dnsHost || ''
			})
		}, { timeoutMs: 10000 });
		if (!resp.ok) {
			console.warn(`[mesh] master rejected this site's gateway details: HTTP ${resp.status}`);
			return { pushed: false, reason: `HTTP ${resp.status}` };
		}
		return { pushed: true };
	} catch (err) {
		console.warn(`[mesh] could not send this site's gateway details to the master: ${err.message}`);
		return { pushed: false, reason: err.message };
	}
}

/**
 * Adopt the roster carried in a master export.
 *
 * This site's OWN row is skipped: its gateway publishes locally and pushes up,
 * so the local copy is always at least as fresh as the master's, and letting a
 * (possibly stale) export overwrite it would blank out a key that was just
 * published. If this site has no local row yet, the master's identity is
 * adopted as an initial placeholder so the site is never missing.
 */
async function adoptRoster(meshSites) {
	if (!Array.isArray(meshSites) || !meshSites.length) return { adopted: 0 };
	const ownId = localSiteId();
	let adopted = 0;
	for (const row of meshSites) {
		const siteId = Number(row.siteId);
		if (!siteId || siteId > MAX_SITE_ID) continue;
		if (ownId && siteId === Number(ownId)) continue;

		const fields = {
			slug: row.slug || '', name: row.name || '',
			gatewayPublicKey: row.gatewayPublicKey || '',
			gatewayEndpoint: row.gatewayEndpoint || '',
			gatewayExitPublicKey: row.gatewayExitPublicKey || '',
			isHub: !!row.isHub, exitOpen: !!row.exitOpen,
			country: row.country || '', city: row.city || '',
			lan168: row.lan168 || '', lan172: row.lan172 || '',
			dnsHost: row.dnsHost || '',
			publishedAt: Number(row.publishedAt || 0),
			lastSeenAt: Number(row.lastSeenAt || 0)
		};
		const existing = await bySiteId(siteId);
		if (existing) await existing.update(fields);
		else await MeshSite.create({ id: crypto.randomUUID(), siteId, ...fields });
		adopted++;
	}
	return { adopted };
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
	localSiteId, roster, bySiteId, publishLocalSite, syncFromSpokes, hub, setHub,
	pushSelfToMaster, adoptRoster, toPublicSafe
};
