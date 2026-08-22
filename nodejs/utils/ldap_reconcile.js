'use strict';

// Keeps THIS node's live OpenLDAP replication config matching the cluster,
// automatically. Nothing here requires an operator, and nothing here requires
// setup.sh: applying is a runtime ldapmodify against cn=config
// (utils/ldap_runtime_config.js).
//
// It is called on every event that can change what this node's peer list
// should be:
//
//   master  — a spoke registers (POST /api/site/spokes), or is removed
//             (DELETE /api/site/spokes/:id), or is inherited during a
//             promotion.
//   spoke   — it joins, resyncs, or is re-pointed at a new master. A spoke
//             asks the master what its config should be (GET /ldap-peers),
//             which is the same answer the master computes for itself.
//   both    — at boot, since the cluster may have changed while this node
//             was down, and the entrypoint's slapd.conf seed only carries
//             whatever LDAP_SERVER_ID/LDAP_REPLICATION_HOSTS happened to be
//             in the environment.
//
// Every call is best-effort and converging: a failure is logged and retried
// by the next event or the periodic sweep, never thrown at the caller. A
// spoke that can't reach its master keeps replicating with whatever it has,
// which is strictly better than tearing config down.

const fs = require('fs');
const siteConfig = require('./site_config');
const { applyReplicationConfig } = require('./ldap_runtime_config');
const { ldapHostForSpoke } = require('./ldap_replication');

// Belt and braces for the cases no event covers: a peer's endpoint changed
// while this node was unreachable, or a master-side write happened during a
// WAN outage. Cheap -- a no-op when nothing differs.
const SWEEP_INTERVAL_MS = Number(process.env.LDAP_RECONCILE_INTERVAL_MS || 10 * 60 * 1000);

let sweepTimer = null;
let inFlight = null;
// Set when a trigger arrives mid-pass: the loop re-runs rather than dropping it.
let dirty = false;
let dirtyReason = null;

// What this node's replication config should be, from whichever side knows.
async function desiredConfig() {
	const cfg = siteConfig.get();

	if (cfg.isMaster) {
		// The master holds the registry, so it computes its own answer with no
		// round trip: ServerID 1 (reserved for the master), peers are every
		// registered spoke that has been assigned an id.
		const { SiteSpoke } = require('../models/site_spoke');
		const spokes = (await SiteSpoke.list().catch(() => [])) || [];
		const peers = spokes
			.filter((s) => s.ldapServerId)
			.map((s) => ({ ldapServerId: s.ldapServerId, ldapHost: ldapHostForSpoke(s) }))
			.filter((p) => p.ldapHost);
		return { serverId: 1, peers };
	}

	if (!cfg.masterUrl || (!cfg.masterJoinKey && !cfg.replicationPushToken) || !cfg.selfUrl) {
		return null; // not enough to ask with; nothing to converge on
	}

	const { fetchWithAuthRedirect } = require('./fetch_with_auth_redirect');
	try {
		const url = `${String(cfg.masterUrl).replace(/\/+$/, '')}/api/site/ldap-peers` +
			`?endpoint=${encodeURIComponent(cfg.selfUrl)}`;
		const resp = await fetchWithAuthRedirect(url, {
			headers: { Authorization: 'Bearer ' + (cfg.replicationPushToken || cfg.masterJoinKey) }
		}, { timeoutMs: 10000 });
		if (!resp.ok) return null;
		const body = await resp.json();
		if (!body || !body.ldapServerId) return null;
		return { serverId: body.ldapServerId, peers: body.peers || [] };
	} catch (e) {
		return null;
	}
}

async function onePass(reason) {
	try {
		const desired = await desiredConfig();
		if (!desired) return { applied: false, note: 'no cluster view available yet' };

		// Persist the id the cluster says this node has, so everything that
		// needs "which site am I" (utils/mesh_roster.js in particular) reads one
		// authoritative value instead of the boot-time slapd.conf seed, which
		// lags a join by a whole setup.sh run.
		//
		// NEVER for a node that has no persisted role yet. A fresh install
		// defaults to isMaster:true, so this branch would compute serverId 1 and
		// CREATE /config/site.json at boot on a node that has never joined
		// anything -- and theta-suite's setup.sh reads the presence of that file
		// as "this node is already a spoke" and skips the join step entirely.
		// Net effect, shipped in v2.24.0: a spoke brought up from spoke.env
		// silently came up as a second master. (setup.sh's guard is being made
		// role-aware too; both halves were wrong, and either one alone would
		// still have broken it.)
		//
		// Nothing is lost by skipping it: 1 is the master's reserved id, which
		// mesh_roster.localSiteId() already falls back to for a master. A master
		// that DOES have an id on file (a promoted former spoke, still carrying
		// its old id) is still corrected, because that write cannot create the
		// file -- it already exists.
		const cfgNow = siteConfig.get();
		// Only persist the assigned id when this node has already made a role
		// decision (site.json exists). A fresh install defaults to isMaster:true
		// and would otherwise create site.json at boot, which made setup.sh
		// treat the node as already joined and skip the actual join step.
		const siteFileExists = fs.existsSync(siteConfig.configFile());
		const mayPersist = !cfgNow.isMaster || (siteFileExists && cfgNow.ldapServerId !== undefined);
		if (mayPersist && desired.serverId && cfgNow.ldapServerId !== desired.serverId) {
			try { siteConfig.save({ ldapServerId: desired.serverId }); } catch (e) { /* non-fatal */ }
		}

		const result = await applyReplicationConfig(desired);
		if (result.changed) {
			console.log(`[ldap-reconcile] (${reason}) ${result.note}`);
		} else if (!result.applied) {
			console.error(`[ldap-reconcile] (${reason}) could not apply: ${result.note}`);
		}
		return result;
	} catch (e) {
		console.error(`[ldap-reconcile] (${reason}) failed:`, e.message);
		return { applied: false, note: e.message };
	}
}

// Converge this node's live slapd on the cluster's current view.
//
// Serialized, because two concurrent ldapmodify streams would race each other
// — but serialized with a DIRTY FLAG, not by dropping the request. Returning
// the in-flight promise to a caller that arrived mid-pass looks like
// coalescing and is actually data loss: that caller's change happened AFTER
// the running pass read the registry, so it is not represented in the result
// it would be handed. Two spokes registering back to back is enough to
// trigger it, and the second one's peer then sat unapplied until the
// ten-minute sweep. (Found by driving the real UI, not by the e2e, whose
// registrations happened to be spread out in time.)
//
// So: a request arriving during a pass marks the state dirty, and the loop
// runs again when the current pass finishes.
async function reconcileReplication(reason) {
	if (inFlight) {
		dirty = true;
		dirtyReason = reason;
		return inFlight;
	}

	inFlight = (async () => {
		let currentReason = reason;
		let result;
		for (;;) {
			result = await onePass(currentReason);
			if (!dirty) break;
			dirty = false;
			currentReason = dirtyReason || currentReason;
		}
		return result;
	})().finally(() => { inFlight = null; });

	return inFlight;
}

// Fire-and-forget wrapper for request handlers: converging replication must
// never delay or fail the API call that triggered it.
function reconcileSoon(reason) {
	setImmediate(() => {
		reconcileReplication(reason).catch(() => { /* already logged */ });
	});
}

function startReplicationReconciler() {
	reconcileSoon('boot');
	if (sweepTimer) clearInterval(sweepTimer);
	sweepTimer = setInterval(() => reconcileSoon('periodic-sweep'), SWEEP_INTERVAL_MS);
	if (sweepTimer.unref) sweepTimer.unref();
}

function stopReplicationReconciler() {
	if (sweepTimer) clearInterval(sweepTimer);
	sweepTimer = null;
}

module.exports = {
	reconcileReplication, reconcileSoon,
	startReplicationReconciler, stopReplicationReconciler,
	desiredConfig, SWEEP_INTERVAL_MS
};
