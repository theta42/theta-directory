'use strict';

// Promotion handoff for clusters with more than two sites (MULTI_SITE_SPEC.md
// §3). Splitting this out of routes/api_directory_admin.js keeps the
// reconciliation logic testable without standing up three HTTP servers.
//
// The gap this closes: a promoted node was, by definition, a spoke, so its own
// SiteSpoke registry is empty. `site-promote` fanned out
// replicateToSpokes('master-promoted') over that empty registry -- a no-op --
// and every OTHER spoke in the cluster kept its masterUrl pointed at the node
// that had just been demoted. Two-site clusters happened to work (the demoted
// master re-registers itself), which is exactly why the e2e never caught it.
//
// So: the demoted master hands over its registry (POST /api/site/demote's
// response), this module writes those rows locally and then calls
// POST /api/site/master-changed on each one to re-point it here.

const crypto = require('crypto');
const { SiteSpoke } = require('../models/site_spoke');
const { nextFreeLdapServerId } = require('./ldap_replication');
const { withLock } = require('./mutex');

const REPOINT_TIMEOUT_MS = 15000;

const trimSlash = (u) => String(u || '').replace(/\/+$/, '');

// Two phases, and the split matters.
//
// Phase 1 (LOCKED) writes the inherited rows: it allocates ServerIDs the same
// read-then-write way POST /api/site/spokes does, so it shares that route's
// lock or a spoke registering mid-promotion could be handed an id this loop
// is about to use.
//
// Phase 2 (UNLOCKED) re-points each spoke over HTTP. This must NOT hold the
// lock: POST /api/site/master-changed makes the spoke turn around and call
// THIS node's POST /api/site/spokes, which takes the same lock — so holding
// it across the outbound call deadlocks until the 15s abort fires and every
// sibling comes back "re-point failed: This operation was aborted".
//
// utils/mutex.js now fails that shape loudly (an acquisition timeout naming
// the holder, rather than a request that never answers), but the split is
// still what makes it correct — a clear error is not a working promotion.
async function adoptInheritedSpokes({ inheritedSpokes, selfUrl, promotionKey, fetchImpl }) {
	const adopted = await withLock('site-spoke-register',
		() => adoptRows({ inheritedSpokes, selfUrl }),
		{ label: 'promotion: adopting inherited spokes' });
	return repointAll({ ...adopted, selfUrl, promotionKey, fetchImpl });
}

async function adoptRows({ inheritedSpokes, selfUrl }) {
	const results = [];
	const pending = [];
	if (!inheritedSpokes || inheritedSpokes.length === 0) {
		return { adopted: 0, results, pending };
	}

	// ldapServerIds already claimed locally, so an inherited id is preserved
	// when it's free and reassigned when it would collide (the old master's
	// ids and this node's were issued independently).
	const localSpokes = (await SiteSpoke.list().catch(() => [])) || [];
	const used = new Set(localSpokes.map((s) => s.ldapServerId).filter(Boolean));
	// 1 is the master's reserved id -- which is now THIS node.
	used.add(1);

	const self = trimSlash(selfUrl);
	let adopted = 0;

	for (const inherited of inheritedSpokes) {
		const endpoint = trimSlash(inherited && inherited.endpoint);
		// Skip this node's own row: the old master had us registered as one of
		// its spokes, and we are not our own spoke.
		if (!endpoint || (self && endpoint === self)) continue;

		const result = { endpoint, note: '' };
		let row = localSpokes.find((s) => trimSlash(s.endpoint) === endpoint);

		let ldapServerId = inherited.ldapServerId && !used.has(inherited.ldapServerId)
			? inherited.ldapServerId
			: null;
		if (!ldapServerId) {
			ldapServerId = await nextFreeLdapServerId().catch(() => null);
			// nextFreeLdapServerId reads the DB, which doesn't yet know about
			// ids claimed earlier in THIS loop; step past those too.
			while (ldapServerId && used.has(ldapServerId)) ldapServerId += 1;
		}
		if (ldapServerId) used.add(ldapServerId);

		const now = Math.floor(Date.now() / 1000);
		const patch = {
			siteSlug: inherited.siteSlug || null,
			// Keep the token the spoke already trusts -- it is what lets this
			// node authenticate the re-point call below.
			pushToken: inherited.pushToken || SiteSpoke.generatePushToken(),
			noInbound: !!inherited.noInbound,
			meshIp: inherited.meshIp || '',
			publicHost: inherited.publicHost || '',
			ldapServerId,
			last_seen_on: now
		};

		try {
			if (row) {
				await row.update(patch);
			} else {
				row = await SiteSpoke.create({ id: crypto.randomUUID(), endpoint, created_on: now, ...patch });
			}
			adopted++;
			result.note = 'adopted';
		} catch (e) {
			result.note = 'adoption failed: ' + e.message;
			results.push(result);
			continue;
		}

		results.push(result);
		pending.push({ endpoint, pushToken: patch.pushToken, result });
	}

	return { adopted, results, pending };
}

// Phase 2: tell each adopted spoke to follow this node. Runs with NO lock
// held (see the note above). Best-effort per spoke — one unreachable sibling
// must not abort the promotion or block the others; it shows up in the report.
async function repointAll({ adopted, results, pending, selfUrl, promotionKey, fetchImpl }) {
	const doFetch = fetchImpl || fetch;
	const self = trimSlash(selfUrl);
	let repointed = 0;

	for (const { endpoint, pushToken, result } of pending || []) {
		if (!promotionKey || !self) {
			result.note += '; not re-pointed (no promotion key or selfUrl)';
			continue;
		}
		try {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), REPOINT_TIMEOUT_MS);
			let resp;
			try {
				resp = await doFetch(endpoint + '/api/site/master-changed', {
					method: 'POST',
					headers: { Authorization: 'Bearer ' + pushToken, 'Content-Type': 'application/json' },
					body: JSON.stringify({ newMasterUrl: self, newJoinKey: promotionKey, selfEndpoint: endpoint }),
					signal: controller.signal
				});
			} finally { clearTimeout(timer); }
			if (resp && resp.ok) {
				repointed++;
				result.note += '; re-pointed at this node';
			} else {
				result.note += '; re-point failed: HTTP ' + (resp && resp.status);
			}
		} catch (e) {
			result.note += '; re-point failed: ' + e.message;
		}
	}

	return { adopted, repointed, results };
}

module.exports = { adoptInheritedSpokes, REPOINT_TIMEOUT_MS };
