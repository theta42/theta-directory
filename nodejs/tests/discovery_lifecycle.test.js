'use strict';

// Garbage collection, source removal, and the identity guard that keeps an
// iLO out of the server it manages.

require('./setup');
const crypto = require('crypto');
const { DiscoveryReconciler } = require('../services/discovery_reconciler');
const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { accessibleResources } = require('../services/access_projection');
const { identityClassFor, _setTemplateCache } = require('../services/subtype_templates');

const DAY = 24 * 60 * 60 * 1000;
const uuid = () => crypto.randomUUID();

async function clearAll() {
  for (const e of await ResourceEdge.list()) await e.delete();
  for (const g of await ResourceGroup.list()) await g.delete();
  for (const r of await Resource.list()) await r.delete();
}
const mk = (slug, metadata, kind = 'host') =>
  Resource.create({ id: uuid(), kind, name: slug, slug, metadata, created_on: 1 });
const alive = async (slug) => Boolean((await Resource.list()).find(r => r.slug === slug));

describe('garbage collection actually collects', () => {
  beforeEach(clearAll);
  afterAll(clearAll);

  test('stale discovery output is archived, then purged with its edges', async () => {
    const site = await mk('gc-site', { isCurrentSite: true }, 'site');
    const fresh = await mk('gc-fresh', { discovery_sources: ['nmap'], last_seen: Date.now() });
    const stale = await mk('gc-stale', { discovery_sources: ['nmap'], last_seen: Date.now() - 10 * DAY });
    const ancient = await mk('gc-ancient', { discovery_sources: ['nmap'], last_seen: Date.now() - 90 * DAY });
    await ResourceEdge.create({ id: uuid(), parentId: site.id, childId: ancient.id, relation: 'hosts' });
    await ResourceGroup.create({ id: uuid(), resourceId: ancient.id, groupCn: 'x_access', accessLevel: 'member' });

    const out = await DiscoveryReconciler.garbageCollect();
    expect(out).toEqual({ archived: 1, purged: 1 });

    expect((await Resource.get(fresh.id)).metadata.lifecycle_state).toBeUndefined();
    expect((await Resource.get(stale.id)).metadata.lifecycle_state).toBe('archived');
    expect(await alive('gc-ancient')).toBe(false);
    // Dependents went with it: an edge pointing at a deleted id breaks getGraph.
    expect(await ResourceEdge.list({ where: { childId: ancient.id } })).toHaveLength(0);
    expect(await ResourceGroup.list({ where: { resourceId: ancient.id } })).toHaveLength(0);
  });

  test('promoted and manual resources are never collected, however quiet', async () => {
    await mk('gc-promoted', { discovery_sources: ['nmap'], managed: true, last_seen: Date.now() - 90 * DAY });
    await mk('gc-manual', { discovery_sources: ['manual'], last_seen: Date.now() - 90 * DAY });
    await mk('gc-handmade', { last_seen: Date.now() - 90 * DAY });

    expect(await DiscoveryReconciler.garbageCollect()).toEqual({ archived: 0, purged: 0 });
    for (const slug of ['gc-promoted', 'gc-manual', 'gc-handmade']) {
      expect(await alive(slug)).toBe(true);
    }
  });

  test('archived means something: it leaves the catalog', async () => {
    const site = await mk('arch-site', { isCurrentSite: true }, 'site');
    const gone = await mk('arch-host', {
      subType: 'linux', discovery_sources: ['nmap'],
      lifecycle_state: 'archived', last_seen: Date.now() - 10 * DAY
    });
    const here = await mk('live-host', { subType: 'linux', discovery_sources: ['nmap'], managed: true });
    const edges = [{ parentId: site.id, childId: gone.id }, { parentId: site.id, childId: here.id }];

    const reachable = accessibleResources(
      [site, gone, here].map(r => r.toJSON ? r.toJSON() : r), edges,
      { grants: new Map([[site.id, 'owner']]), memberOf: [] });
    const slugs = reachable.map(r => r.slug);
    expect(slugs).toContain('live-host');
    expect(slugs).not.toContain('arch-host');
  });
});

describe('forgetSource', () => {
  beforeEach(clearAll);
  afterAll(clearAll);

  test('removes what a source created, and its edges', async () => {
    const site = await mk('fs-site', { isCurrentSite: true }, 'site');
    const owned = await mk('fs-owned', { discovery_sources: ['pve-1'], last_seen: Date.now() });
    await ResourceEdge.create({ id: uuid(), parentId: site.id, childId: owned.id, relation: 'hosts', source: 'pve-1' });

    const out = await DiscoveryReconciler.forgetSource('pve-1');
    expect(out.removed).toBe(1);
    expect(await alive('fs-owned')).toBe(false);
    expect((await ResourceEdge.list()).filter(e => e.source === 'pve-1')).toHaveLength(0);
  });

  test('a resource another source also reported survives, minus the attribution', async () => {
    await mk('fs-shared', { discovery_sources: ['pve-1', 'nmap'], last_seen: Date.now() });
    const out = await DiscoveryReconciler.forgetSource('pve-1');
    expect(out.removed).toBe(0);
    expect(out.kept).toBe(1);
    const after = (await Resource.list()).find(r => r.slug === 'fs-shared');
    expect(after.metadata.discovery_sources).toEqual(['nmap']);
  });

  test('a promoted resource is kept by default and removable on request', async () => {
    await mk('fs-promoted', { discovery_sources: ['pve-1'], managed: true, last_seen: Date.now() });
    expect((await DiscoveryReconciler.forgetSource('pve-1')).kept).toBe(1);
    expect(await alive('fs-promoted')).toBe(true);

    expect((await DiscoveryReconciler.forgetSource('pve-1', { keepPromoted: false })).removed).toBe(0);
  });

  test('an unknown source is a no-op', async () => {
    await mk('fs-other', { discovery_sources: ['nmap'], last_seen: Date.now() });
    expect(await DiscoveryReconciler.forgetSource('nothing-here'))
      .toEqual({ removed: 0, kept: 0, edgesRemoved: 0 });
    expect(await alive('fs-other')).toBe(true);
  });
});

describe('identity class keeps a BMC out of the server it manages', () => {
  afterEach(() => _setTemplateCache(null));

  test('an iLO is a host structurally but its own merge class', () => {
    const ilo = { kind: 'host', metadata: { subType: 'ilo' } };
    const server = { kind: 'host', metadata: { subType: 'linux' } };
    expect(identityClassFor(ilo)).toBe('bmc');
    expect(identityClassFor(server)).toBe('host');
    expect(identityClassFor(ilo)).not.toBe(identityClassFor(server));
  });

  test('a template merges with the host it was made from', () => {
    expect(identityClassFor({ kind: 'host', metadata: { subType: 'template' } }))
      .toBe(identityClassFor({ kind: 'host', metadata: { subType: 'vm' } }));
  });

  test('a container is a service', () => {
    expect(identityClassFor({ kind: 'service', metadata: { subType: 'docker' } })).toBe('service');
  });

  test('rows carrying the old made-up kinds still classify correctly', () => {
    expect(identityClassFor({ kind: 'bmc', metadata: {} })).toBe('bmc');
    expect(identityClassFor({ kind: 'container', metadata: {} })).toBe('service');
    expect(identityClassFor({ kind: 'network_device', metadata: {} })).toBe('host');
    expect(identityClassFor({ kind: 'template', metadata: {} })).toBe('host');
  });

  test('discovery will not fold an iLO into a host with the same address', async () => {
    await clearAll();
    await mk('site-bmc', { isCurrentSite: true }, 'site');
    await mk('dl380', { subType: 'linux', managed: true, ip: '10.0.0.5', discovery_sources: ['manual'] });

    await DiscoveryReconciler.reconcile('ilo-1', {
      resources: [{
        kind: 'host', name: 'dl380 iLO', slug: 'ilo-dl380',
        metadata: { subType: 'ilo', ip: '10.0.0.5', managed: true }
      }],
      edges: []
    }, { location: 'site-bmc' });

    const all = await Resource.list();
    expect(all.find(r => r.slug === 'dl380')).toBeTruthy();
    expect(all.find(r => r.slug === 'ilo-dl380')).toBeTruthy();
    await clearAll();
  });
});
