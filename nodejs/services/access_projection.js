'use strict';

const { templateFor, hasLiveAgent } = require('./subtype_templates');
const { hasPermission } = require('../utils/groups');

// ── Access projection ───────────────────────────────────────────────────────

// Which resources a set of group CNs can reach.
//
// Shared by /me and /access/:uid, which had two copies of this filter and are
// required to agree: /me is what a human sees in the Directory, /access/:uid is
// what jump-host offers them as a target. A resource visible in one and not the
// other is a bug either way round.
//
// Three things make a resource accessible:
//
//   1. an explicit group grant (a ResourceGroup row for a group the caller
//      holds), or the isPublic flag -- the original rule, unchanged;
//   2. a HOST RUNNING theta-agent -- an agent that is still enrolled, not
//      merely a stale metadata.agentId left behind by a revoked one -- for a
//      caller the group model already grants
//      access to hosts at that site (god_admin, {site}_super_admin, or the
//      {site}_hosts_<level> aggregate -- utils/groups.js hasPermission).
//      Installing the agent needs root on the machine AND a join key from this
//      Directory, so it is already under management; requiring a second,
//      per-host grant before it can be reached adds nothing and is why a fleet
//      of agent hosts offered exactly one jump target;
//   3. a service an agent registered, when the caller can reach its HOST. A
//      systemd unit is not an access boundary of its own -- whoever
//      administers the machine administers its units -- which is why these
//      resources get no groups of their own (services/subtype_templates.js).
//
// Auto-discovered-but-never-promoted resources stay excluded throughout: that
// is discovery output, not catalog content.
function accessibleResources(all, edges, { groupIds, memberOf = [], activeAgentIds } = {}) {

	const inCatalog = (r) => {
		const isAuto = r.metadata?.discovery_sources?.length > 0 && !r.metadata.discovery_sources.includes('manual');
		return !(isAuto && r.metadata?.managed !== true);
	};
	const granted = (r) => groupIds.has(r.id) || Boolean(r.metadata && r.metadata.isPublic);

	const byId = new Map(all.map(r => [r.id, r]));
	const parentOf = new Map();
	for (const e of edges) {
		if (!parentOf.has(e.childId)) parentOf.set(e.childId, e.parentId);
	}

	// The site slug the group model keys on. Walked through parent edges, with
	// a depth cap so a cycle introduced by hand cannot hang the request.
	const siteSlugOf = (r) => {
		let cur = r;
		for (let hops = 0; cur && hops < 32; hops++) {
			if (cur.kind === 'site') return cur.slug;
			cur = byId.get(parentOf.get(cur.id));
		}
		return null;
	};

	const reachable = new Set();
	for (const r of all) {
		if (!inCatalog(r)) continue;
		if (granted(r)) { reachable.add(r.id); continue; }
		if (r.kind !== 'host' || !hasLiveAgent(r, activeAgentIds) || !templateFor(r).sshCapable) continue;
		// hasPermission already answers for god_admin and {site}_super_admin
		// without needing the site, but the aggregate and per-resource grants
		// do need it.
		if (hasPermission(memberOf, { site: siteSlugOf(r), kind: 'host', slug: r.slug }, 'access')) {
			reachable.add(r.id);
		}
	}

	// Agent-registered services follow their host. Resolved after the host pass
	// so a host that became reachable in that pass carries its services with it.
	for (const r of all) {
		if (reachable.has(r.id) || !inCatalog(r) || !templateFor(r).inheritsHost) continue;
		// hostId is written by the agent reconciler; the parent edge is the
		// fallback for a service parented by hand.
		const hostId = (r.metadata && r.metadata.hostId) || parentOf.get(r.id);
		if (hostId && reachable.has(hostId)) reachable.add(r.id);
	}

	return all.filter(r => reachable.has(r.id));
}

module.exports = { accessibleResources };
