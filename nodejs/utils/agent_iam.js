'use strict';

// Node IAM payloads for `iam_apply` (theta-agent DESIGN.md §6).
//
// WHY THIS EXISTS
//
// `iam_apply` has been implemented on both sides of the wire for a long time --
// the agent verifies the signature, checks its `iam` capability and applies the
// payload -- and nothing in this directory ever sent one. The whole IAM engine
// was unreachable: the command sat in HIGH_RISK_COMMANDS with no caller, so a
// host's login policy was whatever its own /etc happened to say.
//
// WHAT IS AND IS NOT DERIVED HERE
//
// `allowed_login_groups` is the one part of the payload this directory honestly
// owns. The group model (utils/groups.js, docs/GROUPS.md) already answers "who
// may reach this host", and the grant graph (services/access_inheritance.js)
// already answers it for per-resource grants that propagate down the tree. That
// maps exactly onto what the agent writes into /etc/security/access.conf.
//
// The other three fields are deliberately left empty, and each for a reason:
//
//   sudo_rules   Scoped sudo is open design gap D5. The only rule derivable
//                from "this group has admin on this host" is ALL/ALL, which is
//                precisely the landmine H12 removed from the LDAP side ("the
//                one-line fix = universal root"). Synthesising it here would
//                walk it straight back in through another door. The agent's
//                applySudoRules stays ready for a scoped mechanism.
//   ssh_keys     The agent's design point is an AuthorizedKeysCommand it serves
//                per login, not a pushed snapshot that goes stale.
//   revoke_users Needs a trigger/event model (DESIGN.md §6 calls it TBD). A
//                revocation list computed at push time is a list of people who
//                were already gone.
//
// Only `access` and above gets shell access: `viewer`/`member` is catalog
// visibility, not a login.

const { Resource, ResourceGroup, ResourceEdge } = require('../models/resource');
const { effectiveGrants, rankOf } = require('../services/access_inheritance');
const groups = require('./groups');

// The minimum effective level that means "may log in to the machine".
const LOGIN_RANK = rankOf('access');

// Build the `iam_apply` payload for one host resource.
//
// Returns null when the host cannot be resolved or sits at no site -- the
// structural group CNs are all site-scoped, so a host with no site has no
// derivable policy, and pushing a list that is only `+:root:ALL` followed by
// `-:ALL:ALL` would lock every LDAP user out of it.
async function buildNodeIAM(hostRes) {
  if (!hostRes || hostRes.kind !== 'host') return null;

  const siteSlug = await Resource.findAncestorSiteSlug(hostRes.id).catch(() => null);
  if (!siteSlug) return null;

  const nameSlug = groups.resourceNameSlug(hostRes.slug || hostRes.name);

  // The structural groups. These exist by naming convention rather than by a
  // row, which is the point of the model: a host at a site is reachable by that
  // site's admins without anyone creating a grant for it.
  const cns = new Set([
    groups.GOD_ADMIN,
    groups.siteSuperAdminCns(siteSlug),
    groups.aggregateGroupCns(siteSlug, 'host', 'admin'),
    groups.aggregateGroupCns(siteSlug, 'host', 'access'),
    groups.resourceGroupCns(siteSlug, 'host', nameSlug, 'admin'),
    groups.resourceGroupCns(siteSlug, 'host', nameSlug, 'access')
  ]);

  // Per-resource grants, including those inherited from an ancestor: a grant on
  // the site reaches the hosts in it (docs/resources-reimagined.md), so reading
  // only the rows attached to this host would miss most real-world access.
  const [allGrants, edges] = await Promise.all([
    ResourceGroup.list().catch(() => []),
    ResourceEdge.list().catch(() => [])
  ]);

  const byGroup = new Map();
  for (const g of allGrants) {
    if (!g.groupCn || !g.resourceId) continue;
    if (!byGroup.has(g.groupCn)) byGroup.set(g.groupCn, new Map());
    byGroup.get(g.groupCn).set(g.resourceId, g.accessLevel);
  }

  for (const [groupCn, direct] of byGroup) {
    // Meta groups (`everyone`, `{site}_everyone`) grant catalog visibility, not
    // a shell. Putting `everyone` in access.conf would make the deny-all line
    // that follows it meaningless.
    if (groups.isMetaGroup(groupCn)) continue;
    const effective = effectiveGrants(direct, edges);
    const level = effective.get(hostRes.id);
    if (level && rankOf(level) >= LOGIN_RANK) cns.add(groupCn);
  }

  return {
    node_id: hostRes.slug || hostRes.id,
    // Seconds, so an operator can tell from the agent's log which push a host
    // is running without the directory having to keep a counter.
    revision: Math.floor(Date.now() / 1000),
    access_control: {
      allowed_login_groups: [...cns].filter(Boolean).sort(),
      sudo_rules: [],
      ssh_keys: [],
      revoke_users: []
    }
  };
}

module.exports = { buildNodeIAM, LOGIN_RANK };
