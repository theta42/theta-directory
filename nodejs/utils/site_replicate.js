'use strict';

// Live replication push -- the piece the shipped v1 join flow doesn't have on
// its own (join is a one-time export/import snapshot; nothing kept a spoke in
// sync afterward). This fires a lightweight "something changed, re-pull" ping
// at every spoke registered in SiteSpoke, concurrently, fire-and-forget: never
// awaited by its caller, and one unreachable spoke never delays or blocks
// another. See MULTI_SITE_SPEC.md §2.2 for why this must never become a
// blocking design (a write must never stall on spoke reachability).
//
// Deliberately a PUSH-A-SIGNAL / PULL-A-SNAPSHOT design, not a push-a-diff
// design: the receiving spoke reacts by calling the master's already-shipped,
// already-tested POST /api/site/export + importDirectory() path again (see
// routes/api_site.js's /resync handler), rather than this module inventing a
// second, parallel way to represent "what changed." Fewer moving parts, and
// no risk of a diff payload and a full export ever disagreeing.

const { SiteSpoke } = require('../models/site_spoke');
const { meshServiceTarget } = require('./mesh_route');

const RESYNC_TIMEOUT_MS = 8000;

function replicateToSpokes(reason) {
	return (async () => {
		let spokes;
		try {
			spokes = await SiteSpoke.list();
		} catch (err) {
			console.error('[site-replicate] failed to list known spokes:', err.message);
			return;
		}
		for (const spoke of spokes) {
			// Not awaited -- every spoke is pushed to concurrently.
			pingOne(spoke, reason).catch((err) => {
				console.error(`[site-replicate] resync ping to ${spoke.endpoint} failed:`, err.message);
			});
		}
	})();
}

// Cross-component routing (MULTI_SITE_SPEC.md): every site is a mesh node, so
// the resync push rides the WireGuard tunnel by default -- the peer's directory
// is dialled at its mesh address (10.<serverId>.0.2) over plain HTTP (the
// tunnel is already encrypted). This is the same preference
// utils/ldap_replication.js applies to LDAP replication, and for the same
// reason: inter-site traffic goes over the mesh, never the open internet.
//
// Falls back to the spoke's public endpoint if the mesh attempt fails (the
// tunnel isn't actually up yet, or unreachable for any other reason) -- never
// let a mesh-routing preference turn into "spoke never gets updates."
function resyncUrls(spoke) {
	const urls = [];
	// Every registered spoke has a ServerID (assigned at join), which is its
	// mesh identity. A spoke without one has no mesh address yet and only the
	// public endpoint is tried.
	if (spoke.ldapServerId) {
		const target = meshServiceTarget(`10.${spoke.ldapServerId}.0.2`);
		if (target) urls.push(`http://${target.host}:${target.port}/api/site/resync`);
	}
	if (spoke.endpoint) {
		urls.push(String(spoke.endpoint).replace(/\/+$/, '') + '/api/site/resync');
	}
	return urls;
}

async function pingOne(spoke, reason) {
	const urls = resyncUrls(spoke);
	let lastErr;
	for (const url of urls) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), RESYNC_TIMEOUT_MS);
		try {
			const resp = await fetch(url, {
				method: 'POST',
				headers: { Authorization: 'Bearer ' + spoke.pushToken, 'Content-Type': 'application/json' },
				body: JSON.stringify({ reason: reason || 'catalog-changed' }),
				signal: controller.signal
			});
			if (!resp.ok) throw new Error('status ' + resp.status);
			// Record that this spoke was reached successfully, so the UI's
			// "last seen" column isn't only updated by manual "Sync now" clicks.
			await spoke.update({ last_seen_on: Math.floor(Date.now() / 1000) }).catch(() => {});
			return; // success -- don't try the next (fallback) URL
		} catch (err) {
			lastErr = err;
		} finally {
			clearTimeout(timer);
		}
	}
	throw lastErr;
}

// pingOne is exported as pushResync for the operator-driven "Sync now" action
// (routes/api_site.js), which unlike the write-triggered fan-out AWAITS the
// result so the UI can report whether the spoke was actually reachable.
module.exports = { replicateToSpokes, resyncUrls, pushResync: pingOne };
