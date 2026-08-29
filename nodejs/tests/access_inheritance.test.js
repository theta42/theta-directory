'use strict';

// Ownership propagates DOWN the tree (docs/resources-reimagined.md,
// "Hierarchical Meaning"). A grant on a site reaches everything under it.
//
// This is an access-control rule, so the tests that matter most are the ones
// that assert it does NOT over-grant: sideways, upward, or at a level stronger
// than the grant that was actually made.

const { effectiveGrants, inheritanceSources, strongest, rankOf } = require('../services/access_inheritance');
const { accessibleResources } = require('../services/access_projection');

const edge = (parentId, childId) => ({ parentId, childId, relation: 'hosts' });
const grants = (obj) => new Map(Object.entries(obj));
const levels = (map) => Object.fromEntries([...map].sort());

// office -> cluster0 -> dl380 -> gitea, plus a sibling branch.
const TREE = [
  edge('office', 'cluster0'),
  edge('cluster0', 'dl380'),
  edge('dl380', 'gitea'),
  edge('office', 'nas'),
  edge('warehouse', 'forklift-pc')
];

describe('effectiveGrants', () => {
  test('a grant on a site reaches every descendant', () => {
    expect(levels(effectiveGrants(grants({ office: 'viewer' }), TREE))).toEqual({
      office: 'viewer', cluster0: 'viewer', dl380: 'viewer', gitea: 'viewer', nas: 'viewer'
    });
  });

  test('it does not leak into a sibling branch', () => {
    const out = effectiveGrants(grants({ office: 'admin' }), TREE);
    expect(out.has('warehouse')).toBe(false);
    expect(out.has('forklift-pc')).toBe(false);
  });

  test('it does not propagate upward', () => {
    const out = effectiveGrants(grants({ gitea: 'owner' }), TREE);
    expect(levels(out)).toEqual({ gitea: 'owner' });
  });

  test('a stronger grant deeper in the tree wins for its own subtree only', () => {
    const out = effectiveGrants(grants({ office: 'viewer', dl380: 'admin' }), TREE);
    expect(levels(out)).toEqual({
      office: 'viewer', cluster0: 'viewer', nas: 'viewer',
      dl380: 'admin', gitea: 'admin'
    });
  });

  // Grants are ADDITIVE. A weaker row on a child does not demote what an
  // ancestor already gave -- there is no deny in this model, and pretending
  // otherwise would be worse than not offering it: an operator who "restricted"
  // a host by adding a viewer row would believe they had taken away an admin
  // they still had through the site.
  test('a weaker grant on a child does not demote what an ancestor gave', () => {
    const out = effectiveGrants(grants({ office: 'admin', dl380: 'viewer' }), TREE);
    expect(out.get('dl380')).toBe('admin');
    expect(out.get('gitea')).toBe('admin');
  });

  test('to reduce access you remove the ancestor grant, not add a weaker one', () => {
    const out = effectiveGrants(grants({ dl380: 'viewer' }), TREE);
    expect(out.get('dl380')).toBe('viewer');
    expect(out.get('gitea')).toBe('viewer');
    expect(out.has('office')).toBe(false);
  });

  test('no grants means no access', () => {
    expect(effectiveGrants(new Map(), TREE).size).toBe(0);
  });

  test('a cycle terminates', () => {
    const cyclic = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    expect(levels(effectiveGrants(grants({ a: 'owner' }), cyclic)))
      .toEqual({ a: 'owner', b: 'owner', c: 'owner' });
  });

  test('a resource can be reached through more than one parent', () => {
    const diamond = [edge('top', 'left'), edge('top', 'right'), edge('left', 'leaf'), edge('right', 'leaf')];
    expect(effectiveGrants(grants({ right: 'admin' }), diamond).get('leaf')).toBe('admin');
    expect(effectiveGrants(grants({ left: 'viewer' }), diamond).get('leaf')).toBe('viewer');
  });

  test('level ranking is strongest-wins and case-insensitive', () => {
    expect(strongest('viewer', 'admin')).toBe('admin');
    expect(strongest('owner', 'admin')).toBe('owner');
    expect(strongest(undefined, 'viewer')).toBe('viewer');
    expect(rankOf('ADMIN')).toBe(rankOf('admin'));
    expect(rankOf('nonsense')).toBe(0);
  });
});

describe('inheritanceSources', () => {
  test('reports where an inherited grant came from, and omits direct ones', () => {
    const src = inheritanceSources(grants({ office: 'viewer' }), TREE);
    expect(src.has('office')).toBe(false);
    expect(src.get('gitea')).toEqual({ level: 'viewer', fromResourceId: 'office' });
  });
});

// ── Through the projection ─────────────────────────────────────────────────

const SITE = { id: 'site1', kind: 'site', slug: 'site_718it', metadata: {} };
const host = (id, slug, metadata = {}) => ({ id, kind: 'host', slug, metadata: { managed: true, ...metadata } });
const svc = (id, slug, metadata = {}) => ({ id, kind: 'service', slug, metadata: { managed: true, ...metadata } });

describe('accessibleResources honours inherited grants', () => {
  const web = host('h1', 'web01', { subType: 'linux' });
  const db = host('h2', 'db01', { subType: 'linux' });
  const app = svc('s1', 'sso-manager-718it', { subType: 'web' });
  const all = [SITE, web, db, app];
  const edges = [edge('site1', 'h1'), edge('site1', 'h2'), edge('h1', 's1')];

  const slugs = (opts) => accessibleResources(all, edges, opts).map(r => r.slug).sort();

  test('a grant on the site reaches its hosts and their services', () => {
    expect(slugs({ grants: grants({ site1: 'viewer' }), memberOf: [] }))
      .toEqual(['db01', 'site_718it', 'sso-manager-718it', 'web01']);
  });

  test('a grant on one host does not reach its sibling', () => {
    expect(slugs({ grants: grants({ h1: 'admin' }), memberOf: [] }))
      .toEqual(['sso-manager-718it', 'web01']);
  });

  test('no grant reaches nothing', () => {
    expect(slugs({ grants: new Map(), memberOf: [] })).toEqual([]);
  });

  test('the legacy groupIds Set is still accepted and still inherits', () => {
    expect(slugs({ groupIds: new Set(['site1']), memberOf: [] }))
      .toEqual(['db01', 'site_718it', 'sso-manager-718it', 'web01']);
  });

  test('inheritance never promotes a discovered-but-unmanaged resource into the catalog', () => {
    const ghost = host('h9', 'lxc-777', { managed: false, discovery_sources: ['proxmox'] });
    const out = accessibleResources([SITE, ghost], [edge('site1', 'h9')],
      { grants: grants({ site1: 'owner' }), memberOf: [] });
    expect(out.map(r => r.slug)).toEqual(['site_718it']);
  });
});

// ── Meta / roster groups ───────────────────────────────────────────────────
//
// A site links `{site}_everyone` as a ResourceGroup row so the group can be
// managed from the site's modal (routes/api_directory_admin.js ensureSiteGroups).
// EVERY user at a site is in that group, and utils/groups.js hasPermission
// deliberately does not honour it. Inheritance must not either -- propagating it
// would silently hand every user at a site access to every resource in it, which
// is what a first cut of this change did.

const { isMetaGroup } = require('../utils/groups');

describe('meta groups grant the resource they are on, and nothing below it', () => {
  test('isMetaGroup recognises the roster groups and nothing else', () => {
    expect(isMetaGroup('everyone')).toBe(true);
    expect(isMetaGroup('site_718it_everyone')).toBe(true);
    expect(isMetaGroup('site_718it_super_admin')).toBe(false);
    expect(isMetaGroup('site_718it_host_web01_access')).toBe(false);
    expect(isMetaGroup(undefined)).toBe(false);
  });

  test('a roster grant on a site does not reach the site’s hosts', () => {
    const out = effectiveGrants(new Map(), TREE, grants({ office: 'member' }));
    expect(levels(out)).toEqual({ office: 'member' });
  });

  test('a real grant alongside a roster grant still inherits', () => {
    const out = effectiveGrants(grants({ office: 'admin' }), TREE, grants({ office: 'member' }));
    expect(out.get('office')).toBe('admin');
    expect(out.get('gitea')).toBe('admin');
  });

  test('a roster grant cannot seed the walk from a deeper node either', () => {
    const out = effectiveGrants(new Map(), TREE, grants({ dl380: 'member' }));
    expect(levels(out)).toEqual({ dl380: 'member' });
  });

  test('through the projection: site roster shows the site, not its contents', () => {
    const web = { id: 'h1', kind: 'host', slug: 'web01', metadata: { managed: true, subType: 'linux' } };
    const all = [SITE, web];
    const edges = [edge('site1', 'h1')];
    const out = accessibleResources(all, edges, {
      grants: new Map(),
      nonInheriting: grants({ site1: 'member' }),
      memberOf: []
    });
    expect(out.map(r => r.slug)).toEqual(['site_718it']);
  });
});
