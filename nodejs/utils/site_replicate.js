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
const { fetchWithAuthRedirect } = require('./fetch_with_auth_redirect');
const { tcpReachable } = require('./tcp_probe');

// The far end does a full export + import before it answers (api_site.js's
// /resync handler), so this has to be generous.
const RESYNC_TIMEOUT_MS = 8000;

// ...which is exactly why the mesh address gets a connect probe first. The
// mesh URL is tried BEFORE the public endpoint, so when a tunnel is down every
// push paid the full 8s above before falling back -- on every write, for every
// spoke. That is not a hypothetical: it is why the multi-site E2E's
// post-promotion replication assertion (a 15s budget) failed about half the
// time, and why "Sync now" in the UI hung for 8s per spoke at any site whose
// tunnel had dropped.
//
// A connect to a tunnel or LAN address either succeeds in milliseconds or is
// not going to succeed, so a second is long. Shortening the REQUEST timeout
// instead would have been wrong: it would abort a mesh push that was working,
// mid-import, and then repeat the whole import over the public endpoint.
const MESH_PROBE_TIMEOUT_MS = 1000;

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
function resyncTargets(spoke) {
	const targets = [];
	// Every registered spoke has a ServerID (assigned at join), which is its
	// mesh identity. A spoke without one has no mesh address yet and only the
	// public endpoint is tried.
	if (spoke.ldapServerId) {
		const target = meshServiceTarget(`10.${spoke.ldapServerId}.0.2`);
		if (target) {
			targets.push({
				url: `http://${target.host}:${target.port}/api/site/resync`,
				// Probed before it is used: see MESH_PROBE_TIMEOUT_MS.
				probe: { host: target.host, port: target.port }
			});
		}
	}
	for (const url of publicUrls(spoke)) targets.push({ url, probe: null });
	return targets;
}

// resyncUrls is the URL-only view of the above, kept because it reads as the
// answer to "where would a resync for this spoke go, in order".
function resyncUrls(spoke) {
	return resyncTargets(spoke).map((t) => t.url);
}

function publicUrls(spoke) {
	const urls = [];
	if (spoke.endpoint) {
		const base = String(spoke.endpoint).replace(/\/+$/, '');
		// Prefer HTTPS directly when the registry says http://. The proxy in
		// front of every spoke redirects HTTP to HTTPS with 301, but over
		// hairpin NAT (both sites behind the same public IP) the 301 target
		// can route to the wrong backend and the push token is rejected. Using
		// HTTPS first routes by SNI/Host and avoids the redirect round-trip.
		if (base.startsWith('http://')) {
			urls.push(base.replace(/^http:\/\//, 'https://') + '/api/site/resync');
		}
		urls.push(base + '/api/site/resync');
	}
	return urls;
}

async function pingOne(spoke, reason) {
	const targets = resyncTargets(spoke);
	let lastErr;
	for (const { url, probe } of targets) {
		// Skip an address nothing is listening on rather than spending the
		// request timeout discovering it. Only the mesh address carries a
		// probe: the public endpoint is the last resort, and "try it and see"
		// is the right thing to do with a last resort.
		if (probe && !(await tcpReachable(probe.host, probe.port, MESH_PROBE_TIMEOUT_MS))) {
			lastErr = new Error(`mesh address ${probe.host}:${probe.port} is not reachable`);
			continue;
		}
		const body = JSON.stringify({ reason: reason || 'catalog-changed' });
		const init = {
			method: 'POST',
			headers: { Authorization: 'Bearer ' + spoke.pushToken, 'Content-Type': 'application/json' },
			body
		};
		try {
			const resp = await fetchWithAuthRedirect(url, init, { timeoutMs: RESYNC_TIMEOUT_MS });
			if (!resp.ok) throw new Error('status ' + resp.status);
			// Record that this spoke was reached successfully, so the UI's
			// "last seen" column isn't only updated by manual "Sync now" clicks.
			await spoke.update({ last_seen_on: Math.floor(Date.now() / 1000) }).catch(() => {});
			return; // success -- don't try the next (fallback) URL
		} catch (err) {
			lastErr = err;
		}
	}
	throw lastErr;
}

// pingOne is exported as pushResync for the operator-driven "Sync now" action
// (routes/api_site.js), which unlike the write-triggered fan-out AWAITS the
// result so the UI can report whether the spoke was actually reachable.
module.exports = { replicateToSpokes, resyncUrls, resyncTargets, pushResync: pingOne };
