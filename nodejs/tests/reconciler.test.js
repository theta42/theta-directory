require('./setup');
const { Resource, ResourceGroup } = require('../models/resource');
const { DiscoveryReconciler } = require('../services/discovery_reconciler');

describe('DiscoveryReconciler', () => {
  beforeEach(async () => {
    // Clear resources before each test
    const all = await Resource.list();
    for (const r of all) {
      await r.delete();
    }
  });

  it('should create a new device if no MAC or IP matches', async () => {
    const payload = {
      resources: [{
        kind: 'host',
        name: 'New Host',
        slug: 'new-host',
        metadata: {
          interfaces: [{ mac: '00:11:22:33:44:55', ip: '192.168.1.100' }]
        }
      }]
    };

    await DiscoveryReconciler.reconcile('test-plugin', payload);

    const all = (await Resource.list()).filter(r => r.kind !== 'site');
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('New Host');
    expect(all[0].metadata.discovery_sources).toContain('test-plugin');
  });

  it('should merge into an existing device if MAC matches', async () => {
    // 1. Initial creation
    await DiscoveryReconciler.reconcile('plugin-A', {
      resources: [{
        kind: 'unmanaged_device',
        name: 'Old Host',
        slug: 'old-host',
        metadata: {
          os: 'Linux',
          interfaces: [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.5' }]
        }
      }]
    });

    // 2. Secondary discovery from a different plugin, same MAC but new IP
    await DiscoveryReconciler.reconcile('plugin-B', {
      resources: [{
        kind: 'host',
        name: 'Updated Host', // Name updates aren't overwritten in simple merge, but let's see
        metadata: {
          cpu_cores: 4,
          interfaces: [{ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.6' }]
        }
      }]
    });

    const all = (await Resource.list()).filter(r => r.kind !== 'site');
    expect(all).toHaveLength(1); // Should have merged, not created a new one
    
    const merged = all[0];
    expect(merged.metadata.discovery_sources).toContain('plugin-A');
    expect(merged.metadata.discovery_sources).toContain('plugin-B');
    
    // Metadata should be merged
    expect(merged.metadata.os).toBe('Linux');
    expect(merged.metadata.cpu_cores).toBe(4);
    
    // Interface array should be merged/updated
    expect(merged.metadata.interfaces).toHaveLength(1);
    expect(merged.metadata.interfaces[0].ip).toBe('10.0.0.6'); // Updated IP

    // Each source's own contribution survives alongside the flat merge,
    // additively -- see utils/fact_sources.js. This does not change what the
    // flat fields above resolve to.
    expect(merged.metadata.facts_by_source['plugin-A'].os).toBe('Linux');
    expect(merged.metadata.facts_by_source['plugin-B'].cpu_cores).toBe(4);
    expect(merged.metadata.facts_by_source['plugin-B'].interfaces[0].ip).toBe('10.0.0.6');
  });

  it('does not duplicate access/admin groups across repeated autoPromote passes', async () => {
    // Regression: autoPromote used to call ResourceGroup.create() directly
    // with no existence check, so reconciling the same managed resource
    // more than once (e.g. a Proxmox cluster reporting one LXC from
    // multiple nodes) accumulated duplicate access/admin rows every pass.
    const payload = {
      resources: [{
        kind: 'host',
        name: 'LXC 127',
        slug: 'lxc-127',
        metadata: { interfaces: [{ mac: '00:11:22:33:44:99', ip: '10.0.0.99' }] }
      }]
    };

    await DiscoveryReconciler.reconcile('plugin-A', payload, { autoPromote: true });
    await DiscoveryReconciler.reconcile('plugin-A', payload, { autoPromote: true });
    await DiscoveryReconciler.reconcile('plugin-A', payload, { autoPromote: true });

    const resource = (await Resource.list()).find((r) => r.slug === 'lxc-127');
    const groups = await ResourceGroup.list({ where: { resourceId: resource.id } });
    expect(groups.map((g) => g.groupCn).sort()).toEqual([]);
  });

  it('purges vanished discovered resources when a structural discovery source no longer reports them', async () => {
    // 1. Initial discovery with node and two LXCs
    const payload1 = {
      resources: [
        { kind: 'host', name: 'Node 1', slug: 'pve-node-1', metadata: {} },
        { kind: 'host', name: 'LXC 101', slug: 'lxc-101', metadata: {} },
        { kind: 'host', name: 'LXC 102', slug: 'lxc-102', metadata: {} },
      ],
      edges: [
        { parentSlug: 'pve-node-1', childSlug: 'lxc-101', relation: 'hosts' },
        { parentSlug: 'pve-node-1', childSlug: 'lxc-102', relation: 'hosts' },
      ]
    };
    await DiscoveryReconciler.reconcile('pve-plugin', payload1, { autoPromote: true });

    let all = await Resource.list();
    expect(all.map(r => r.slug).sort()).toEqual(expect.arrayContaining(['lxc-101', 'lxc-102', 'pve-node-1']));

    // 2. LXC 102 was deleted on Proxmox -> next discovery payload only contains LXC 101
    const payload2 = {
      resources: [
        { kind: 'host', name: 'Node 1', slug: 'pve-node-1', metadata: {} },
        { kind: 'host', name: 'LXC 101', slug: 'lxc-101', metadata: {} },
      ],
      edges: [
        { parentSlug: 'pve-node-1', childSlug: 'lxc-101', relation: 'hosts' },
      ]
    };
    await DiscoveryReconciler.reconcile('pve-plugin', payload2, { autoPromote: true });

    all = await Resource.list();
    const slugs = all.map(r => r.slug);
    expect(slugs).toContain('pve-node-1');
    expect(slugs).toContain('lxc-101');
    expect(slugs).not.toContain('lxc-102');
  });
});

// A plugin naming a parent that does not exist used to fail twice over: the
// edge was dropped in silence, AND the child was excluded from the site
// fallback below it -- because that fallback keyed on "appeared as a childSlug
// in the payload" rather than "actually got parented". The result was a
// resource with no parent at all, floating at the root of the tree, with
// nothing in the log to say why. Live symptom: `docker-theta-suite-sso-manager`
// sitting beside the site on every fresh install.
describe('DiscoveryReconciler unresolvable parents', () => {
  beforeEach(async () => {
    const all = await Resource.list();
    for (const r of all) await r.delete();
  });

  const { ResourceEdge } = require('../models/resource');

  async function parentsOf(slug) {
    const all = await Resource.list();
    const res = all.find((r) => r.slug === slug);
    if (!res) return null;
    const edges = await ResourceEdge.list();
    return edges
      .filter((e) => e.childId === res.id)
      .map((e) => (all.find((r) => r.id === e.parentId) || {}).slug);
  }

  it('parents a child to the site when its declared parent does not exist', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await DiscoveryReconciler.reconcile('docker', {
        resources: [{ kind: 'container', name: 'sso-manager', slug: 'docker-theta-suite-sso-manager', metadata: {} }],
        edges: [{ parentSlug: 'sso-manager', childSlug: 'docker-theta-suite-sso-manager', relation: 'runs' }],
      });

      const parents = await parentsOf('docker-theta-suite-sso-manager');
      expect(parents).not.toBeNull();
      expect(parents).toHaveLength(1);

      const all = await Resource.list();
      const site = all.find((r) => r.kind === 'site');
      expect(parents[0]).toBe(site.slug);

      // And it must say so, rather than dropping the edge in silence.
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/does not resolve/);
    } finally {
      warn.mockRestore();
    }
  });

  it('still prefers the declared parent when it does resolve', async () => {
    await DiscoveryReconciler.reconcile('docker', {
      resources: [
        { kind: 'service', name: 'SSO Manager', slug: 'sso-manager-718it', metadata: {} },
        { kind: 'container', name: 'sso-manager', slug: 'docker-theta-suite-sso-manager', metadata: {} },
      ],
      edges: [{ parentSlug: 'sso-manager-718it', childSlug: 'docker-theta-suite-sso-manager', relation: 'runs' }],
    });

    expect(await parentsOf('docker-theta-suite-sso-manager')).toEqual(['sso-manager-718it']);
  });

  it('prunes redundant direct site edge when a hypervisor parent edge is established for an existing host', async () => {
    const site = (await Resource.list()).find(r => r.kind === 'site') || await Resource.create({
      id: crypto.randomUUID(),
      kind: 'site',
      name: '718it',
      slug: 'site_718it',
      metadata: { isCurrentSite: true }
    });
    const existingHost = await Resource.create({
      id: crypto.randomUUID(),
      kind: 'host',
      name: 'theta-suite-718it',
      slug: 'host_theta-suite-718it',
      metadata: { ip: '192.168.1.57' }
    });
    // Direct site edge from bootstrap
    await ResourceEdge.create({
      id: crypto.randomUUID(),
      parentId: site.id,
      childId: existingHost.id,
      relation: 'hosts',
      source: null
    });

    expect(await parentsOf('host_theta-suite-718it')).toEqual([site.slug]);

    // Hypervisor discovers LXC 101 matching existingHost by IP
    await DiscoveryReconciler.reconcile('proxmox-test', {
      resources: [
        { kind: 'host', name: 'dl380-0', slug: 'pve-node-dl380-0', metadata: {} },
        { kind: 'host', name: 'theta-suite-718it', slug: 'lxc-101', metadata: { ip: '192.168.1.57', vmid: 101 } },
      ],
      edges: [
        { parentSlug: 'pve-node-dl380-0', childSlug: 'lxc-101', relation: 'hosts' }
      ]
    }, { autoPromote: true });

    // The host should now be parented ONLY by pve-node-dl380-0 (direct site edge pruned)
    expect(await parentsOf('host_theta-suite-718it')).toEqual(['pve-node-dl380-0']);
  });
});
