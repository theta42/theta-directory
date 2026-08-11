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
    expect(groups.map((g) => g.groupCn).sort()).toEqual(['lxc-127_access', 'lxc-127_admin']);
  });
});
