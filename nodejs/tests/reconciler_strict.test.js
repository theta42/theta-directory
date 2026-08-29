'use strict';

require('./setup');
const { DiscoveryReconciler } = require('../services/discovery_reconciler');
const { Resource, ResourceEdge } = require('../models/resource');

async function clearNonSites() {
  const all = await Resource.list();
  for (const r of all) {
    if (r.kind !== 'site') {
      const edges = await ResourceEdge.list({ where: { childId: r.id } });
      for (const e of edges) await e.delete();
      await r.delete();
    }
  }
}

async function seedSites() {
  const existing = await Resource.list({ where: { kind: 'site' } });
  if (existing.length < 2) {
    for (const r of existing) await r.delete();
    await Resource.create({
      id: 'site-a', kind: 'site', name: 'Site A', slug: 'site_a', created_on: 1
    });
    await Resource.create({
      id: 'site-b', kind: 'site', name: 'Site B', slug: 'site_b', created_on: 1
    });
  }
}

describe('DiscoveryReconciler strict matching', () => {
  beforeEach(async () => {
    await seedSites();
    await clearNonSites();
  });

  test('same IP in different sites does not merge across boundaries', async () => {
    await DiscoveryReconciler.reconcile('plugin-A', {
      resources: [{
        kind: 'host', name: 'host-a', slug: 'host-a',
        metadata: { ip: '192.168.1.50', managed: true }
      }],
      edges: []
    }, { location: 'Site A' });

    await DiscoveryReconciler.reconcile('plugin-B', {
      resources: [{
        kind: 'host', name: 'host-b', slug: 'host-b',
        metadata: { ip: '192.168.1.50', managed: true }
      }],
      edges: []
    }, { location: 'Site B' });

    const hosts = (await Resource.list()).filter(r => r.kind === 'host');
    expect(hosts).toHaveLength(2);
  });

  test('same hostname in different sites does not merge across boundaries', async () => {
    await DiscoveryReconciler.reconcile('plugin-A', {
      resources: [{
        kind: 'host', name: 'ubuntu', slug: 'host-ubuntu-a',
        metadata: { managed: true }
      }],
      edges: []
    }, { location: 'Site A' });

    await DiscoveryReconciler.reconcile('plugin-B', {
      resources: [{
        kind: 'host', name: 'ubuntu', slug: 'host-ubuntu-b',
        metadata: { managed: true }
      }],
      edges: []
    }, { location: 'Site B' });

    const hosts = (await Resource.list()).filter(r => r.kind === 'host' && r.name === 'ubuntu');
    expect(hosts).toHaveLength(2);
  });

  test('weak IP match within the same site does merge', async () => {
    await DiscoveryReconciler.reconcile('plugin-A', {
      resources: [{
        kind: 'host', name: 'host-a', slug: 'host-a',
        metadata: { ip: '192.168.1.60', managed: true }
      }],
      edges: []
    }, { location: 'Site A' });

    await DiscoveryReconciler.reconcile('plugin-B', {
      resources: [{
        kind: 'host', name: 'host-renamed', slug: 'host-renamed',
        metadata: { ip: '192.168.1.60', managed: true }
      }],
      edges: []
    }, { location: 'Site A' });

    const hosts = (await Resource.list()).filter(r => r.kind === 'host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].metadata.ip).toBe('192.168.1.60');
  });

  test('weak fallback never hijacks a resource with a MAC identity', async () => {
    await DiscoveryReconciler.reconcile('plugin-A', {
      resources: [{
        kind: 'host', name: 'host-mac', slug: 'host-mac',
        metadata: { macAddress: '00:11:22:33:44:55', ip: '10.0.0.5', managed: true }
      }],
      edges: []
    }, { location: 'Site A' });

    await DiscoveryReconciler.reconcile('plugin-B', {
      resources: [{
        kind: 'host', name: 'impostor', slug: 'host-impostor',
        metadata: { ip: '10.0.0.5', managed: true }
      }],
      edges: []
    }, { location: 'Site A' });

    const hosts = (await Resource.list()).filter(r => r.kind === 'host');
    expect(hosts).toHaveLength(2);
  });
});
