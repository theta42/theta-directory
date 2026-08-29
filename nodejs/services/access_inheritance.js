'use strict';

// Ownership propagates DOWN the tree.
//
// docs/resources-reimagined.md, "Hierarchical Meaning": environment bubbles UP
// (a site carrying one prod LXC is a prod site), and ownership propagates DOWN
// (whoever owns a site owns what is in it). The up half has existed since
// `bubbled_environment`; this is the down half.
//
// The concrete promise, from the same document's goals: "manage who is an
// owner, admin, or viewer of a resource AND ALL ITS INHERITED CHILDREN". A
// grant on `office` reaches `office -> cluster0 -> dl380 -> gitea` without
// anyone having to re-grant it at each level -- which is what made per-resource
// grants unusable at any real scale.
//
// A grant is a ResourceGroup row: (resourceId, groupCn, accessLevel). This
// module answers, for a set of group CNs, the effective level on EVERY
// resource: the strongest level granted on the resource itself or on any
// ancestor of it.

// GRANTS ARE ADDITIVE. There is no deny: a weaker row on a child does not
// demote what an ancestor already gave. That is deliberate, and the alternative
// is worse than not offering it -- an operator who "restricted" a host by
// adding a viewer row would believe they had removed an admin they in fact
// still hold through the site. To reduce someone's access you remove the
// ancestor grant.
//
// Strongest last. `member` appears because access requests write it
// (routes/access_request.js) and it must rank somewhere; it sits with viewer.
const LEVEL_RANK = { viewer: 1, member: 1, access: 2, admin: 3, owner: 4 };

function rankOf(level) {
  return LEVEL_RANK[String(level || '').toLowerCase()] || 0;
}

function strongest(a, b) {
  return rankOf(a) >= rankOf(b) ? a : b;
}

// Build parentId -> [childId]. Edges are the only structure here: `hostId` in
// metadata is a denormalised convenience the reconciler writes, and inheriting
// access through it would mean access followed a field that nothing keeps in
// step with the graph.
function childIndex(edges) {
  const index = new Map();
  for (const e of edges) {
    if (!e.parentId || !e.childId) continue;
    if (!index.has(e.parentId)) index.set(e.parentId, []);
    index.get(e.parentId).push(e.childId);
  }
  return index;
}

// effectiveGrants(directGrants, edges) -> Map(resourceId -> level)
//
// `directGrants` is Map(resourceId -> level): the rows that actually exist.
// The result adds every resource reachable downward from a granted one, at the
// strongest level any ancestor confers.
//
// Breadth-first from each granted root, carrying the level down. Revisits a
// node only when arriving with a STRONGER level than it already has, which
// both terminates on cycles and gets the answer right when two ancestors grant
// different levels (a viewer on the site, an admin on the host: admin wins for
// everything under the host, viewer for its siblings).
// `nonInheriting` is Map(resourceId -> level) for grants that apply to the
// resource itself and go no further -- meta/roster groups (utils/groups.js
// isMetaGroup). A site links `{site}_everyone` so the group can be managed from
// the site's modal, and every user at the site is in it; propagating that down
// would grant everyone access to everything at their site.
function effectiveGrants(directGrants, edges, nonInheriting = new Map()) {
  const children = childIndex(edges);
  const effective = new Map();

  const queue = [];
  for (const [resourceId, level] of directGrants) {
    effective.set(resourceId, level);
    queue.push([resourceId, level]);
  }

  while (queue.length) {
    const [id, level] = queue.shift();
    // A node whose recorded level has since been raised by another path is
    // stale; the stronger walk already covered its subtree.
    if (rankOf(effective.get(id)) > rankOf(level)) continue;

    for (const childId of children.get(id) || []) {
      const current = effective.get(childId);
      const next = strongest(current, level);
      if (rankOf(next) > rankOf(current)) {
        effective.set(childId, next);
        queue.push([childId, next]);
      }
    }
  }

  // Applied after the walk so they cannot seed it.
  for (const [resourceId, level] of nonInheriting) {
    effective.set(resourceId, strongest(effective.get(resourceId), level));
  }

  return effective;
}

// Which resources were reached only by inheritance, and from where. Used by
// the UI to say "viewer, inherited from office" rather than showing a grant
// that does not exist as if someone had made it.
function inheritanceSources(directGrants, edges) {
  const children = childIndex(edges);
  const source = new Map(); // childId -> { level, fromResourceId }
  const level = new Map(directGrants);

  const queue = [...directGrants.keys()].map(id => [id, directGrants.get(id), id]);
  while (queue.length) {
    const [id, lvl, root] = queue.shift();
    if (rankOf(level.get(id)) > rankOf(lvl)) continue;
    for (const childId of children.get(id) || []) {
      const next = strongest(level.get(childId), lvl);
      if (rankOf(next) > rankOf(level.get(childId))) {
        level.set(childId, next);
        if (!directGrants.has(childId)) source.set(childId, { level: next, fromResourceId: root });
        queue.push([childId, next, directGrants.has(id) ? id : root]);
      }
    }
  }
  return source;
}

module.exports = { effectiveGrants, inheritanceSources, LEVEL_RANK, rankOf, strongest };
