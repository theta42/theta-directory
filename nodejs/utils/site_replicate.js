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

async function pingOne(spoke, reason) {
	const url = String(spoke.endpoint).replace(/\/+$/, '') + '/api/site/resync';
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
	} finally {
		clearTimeout(timer);
	}
}

module.exports = { replicateToSpokes };
