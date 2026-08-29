'use strict';

require('./setup');
const crypto = require('crypto');
const { DiscoveryReconciler } = require('../services/discovery_reconciler');
const { Resource, ResourceEdge } = require('../models/resource');

// Edge provenance. `ResourceEdge.source` is what lets a discovery source
// reparent a guest that moved and prune an edge it no longer reports, and it
// is invisible when it breaks: @simpleworkjs/orm silently drops keys that the
// model does not declare, so removing the field does not throw -- every
// `e.source === 'proxmox'` test just quietly goes false and reparenting and
// pruning stop happening, with a green test suite the whole way.

async function clearAll() {
  for (const e of await ResourceEdge.list()) await e.delete();
  for (const r of await Resource.list()) await r.delete();
}

async function site(slug) {
  return Resource.create({
    id: crypto.randomUUID(), kind: 'site', name: slug, slug,
    metadata: { isCurrentSite: true }, created_on: 1
  });
}

describe('ResourceEdge provenance', () => {
  beforeEach(clearAll);

  test('a source written on an edge survives a round trip', async () => {
    const s = await site('site_edges');
    const h = await Resource.create({
      id: crypto.randomUUID(), kind: 'host', name: 'h', slug: 'host-edges-1', created_on: 1
    });
    const created = await ResourceEdge.create({
      id: crypto.randomUUID(), parentId: s.id, childId: h.id, relation: 'hosts', source: 'proxmox'
    });

    expect(created.source).toBe('proxmox');
    expect((await ResourceEdge.get(created.id)).source).toBe('proxmox');
    expect((await ResourceEdge.list({ where: { childId: h.id } }))[0].source).toBe('proxmox');
  });

  test('a guest that moves to another node is reparented, not double-parented', async () => {
    await site('site_move');
    const payload = (parent) => ({
      resources: [
        { kind: 'host', name: parent, slug: parent, metadata: { subType: 'hypervisor', managed: true } },
        { kind: 'host', name: 'guest', slug: 'lxc-900', metadata: { subType: 'lxc', managed: true, macAddress: 'aa:bb:cc:00:09:00' } }
      ],
      edges: [{ parentSlug: parent, childSlug: 'lxc-900', relation: 'hosts' }]
    });

    await DiscoveryReconciler.reconcile('proxmox', payload('node-a'), { location: 'site_move' });
    await DiscoveryReconciler.reconcile('proxmox', payload('node-b'), { location: 'site_move' });

    const guest = (await Resource.list()).find(r => r.slug === 'lxc-900');
    const parents = await ResourceEdge.list({ where: { childId: guest.id } });
    const parentSlugs = [];
    for (const e of parents) parentSlugs.push((await Resource.get(e.parentId)).slug);

    expect(parentSlugs).toEqual(['node-b']);
  });

  test('a source only prunes the edges it created itself', async () => {
    const s = await site('site_prune');
    await DiscoveryReconciler.reconcile('proxmox', {
      resources: [
        { kind: 'host', name: 'node', slug: 'node-p', metadata: { subType: 'hypervisor', managed: true } },
        { kind: 'host', name: 'g1', slug: 'lxc-901', metadata: { subType: 'lxc', managed: true, macAddress: 'aa:bb:cc:00:09:01' } }
      ],
      edges: [{ parentSlug: 'node-p', childSlug: 'lxc-901', relation: 'hosts' }]
    }, { location: 'site_prune' });

    // A hand-made edge, with no source, alongside the discovered one.
    const guest = (await Resource.list()).find(r => r.slug === 'lxc-901');
    const manual = await Resource.create({
      id: crypto.randomUUID(), kind: 'service', name: 'manual', slug: 'svc-manual', created_on: 1
    });
    await ResourceEdge.create({
      id: crypto.randomUUID(), parentId: s.id, childId: manual.id, relation: 'hosts'
    });

    // The next run no longer reports the guest's edge at all.
    await DiscoveryReconciler.reconcile('proxmox', {
      resources: [{ kind: 'host', name: 'node', slug: 'node-p', metadata: { subType: 'hypervisor', managed: true } }],
      edges: [{ parentSlug: 'site_prune', childSlug: 'node-p', relation: 'hosts' }]
    }, { location: 'site_prune' });

    expect(await ResourceEdge.list({ where: { childId: guest.id } })).toHaveLength(0);
    // The operator's own edge is untouched: it has no source, so no source owns it.
    expect(await ResourceEdge.list({ where: { childId: manual.id } })).toHaveLength(1);
  });
});
