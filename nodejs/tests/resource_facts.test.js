'use strict';

const ResourceFacts = require('../public/js/resource_facts');

describe('resource_facts', () => {
  describe('factsFromMetadata', () => {
    test('reads facts_by_source into one static entry per contributing source', () => {
      const metadata = {
        facts_by_source: {
          'proxmox-718': { ram_total_gb: 12, disk_total_gb: 160.4, macAddress: '6e:65:df:28:bb:21', observed_at: 1000 },
          'theta-agent': { ram_total_gb: 12, ip: '192.168.1.206', observed_at: 2000 }
        }
      };
      const facts = ResourceFacts.factsFromMetadata(metadata, 'host1', 'emby');

      expect(facts.memory).toHaveLength(2);
      expect(facts.memory[0]).toMatchObject({ source: 'proxmox-718', kind: 'static', role: 'total', unit: 'bytes' });
      expect(facts.memory[0].value).toBeCloseTo(12 * 1024 * 1024 * 1024);

      expect(facts.disk).toHaveLength(1);
      expect(facts.network.map((n) => n.value)).toEqual(
        expect.arrayContaining(['6e:65:df:28:bb:21', '192.168.1.206'])
      );
    });

    test('falls back to the flat fields tagged source:unknown when facts_by_source is absent', () => {
      const facts = ResourceFacts.factsFromMetadata({ ram_total_gb: 8, last_seen: 5000 }, 'h', 'x');
      expect(facts.memory).toHaveLength(1);
      expect(facts.memory[0].source).toBe('unknown');
      expect(facts.memory[0].observedAt).toBe(5000);
    });

    test('empty metadata produces empty buckets, not an error', () => {
      const facts = ResourceFacts.factsFromMetadata(null, 'h', 'x');
      expect(facts).toEqual({ cpu: [], memory: [], disk: [], network: [] });
    });
  });

  describe('factsFromProxmoxGuestSnapshot', () => {
    // The actual lxc-emby-6e65df28bb21 driver-metrics response from this
    // session's live check against sso.suite.vm42.us.
    const driverMetrics = {
      driver: 'proxmox',
      guestStats: {
        cpuUsagePct: 0.01,
        memoryUsedBytes: 2754367488,
        memoryTotalBytes: 12884901888,
        diskUsedBytes: 91201445888,
        diskTotalBytes: 172193439744
      }
    };

    test('extracts live cpu/memory/disk usage', () => {
      const facts = ResourceFacts.factsFromProxmoxGuestSnapshot(driverMetrics, 'host1', 'emby');
      expect(facts.memory[0]).toMatchObject({ source: 'proxmox', kind: 'live', role: 'used', unit: 'bytes', value: 2754367488 });
      expect(facts.cpu[0]).toMatchObject({ role: 'pct', value: 0.01 });
      expect(facts.disk[0]).toMatchObject({ value: 91201445888 });
    });

    test('empty when guestStats is absent', () => {
      expect(ResourceFacts.factsFromProxmoxGuestSnapshot({}, 'h', 'x')).toEqual({ cpu: [], memory: [], disk: [] });
    });
  });

  describe('factsFromAgentServiceSnapshot', () => {
    test('extracts live cpu/memory from a ServiceMetric', () => {
      const svc = { name: 'emby-server', active: true, cpu_usage_percent: 4.2, memory_bytes: 3425000000 };
      const facts = ResourceFacts.factsFromAgentServiceSnapshot(svc, 'svc1', 'emby-server', 1700);
      expect(facts.memory[0]).toMatchObject({ source: 'theta-agent', kind: 'live', role: 'used', unit: 'bytes', value: 3425000000, observedAt: 1700 });
      expect(facts.cpu[0]).toMatchObject({ value: 4.2 });
    });

    test('empty for a null svc', () => {
      expect(ResourceFacts.factsFromAgentServiceSnapshot(null, 'h', 'x', 0)).toEqual({ cpu: [], memory: [] });
    });
  });

  describe('buildResourceFactsMesh', () => {
    const host = { id: 'host1', name: 'emby', slug: 'lxc-emby-6e65df28bb21', metadata: {} };

    test('flags a conflict between self-live and child-live memory, reproducing the live emby case', () => {
      // Host (Proxmox, live): 2.59 GiB used. Its emby-server child (theta-agent,
      // live): 3.19 GiB used -- a single child reporting more memory than its
      // own container's total, observed live this session.
      const selfLive = { memory: [{ source: 'proxmox', kind: 'live', role: 'used', unit: 'bytes', value: 2781396992, observedAt: 1, resourceId: 'host1', resourceName: 'emby' }] };
      const childSvc = { resource: { id: 'svc1', name: 'emby-server', metadata: {} }, live: { memory: [{ source: 'theta-agent', kind: 'live', role: 'used', unit: 'bytes', value: 3425185792, observedAt: 2, resourceId: 'svc1', resourceName: 'emby-server' }] } };

      const { groups } = ResourceFacts.buildResourceFactsMesh({ resource: host, selfLive, children: [childSvc] });
      const memory = groups.find((g) => g.concept === 'memory');
      expect(memory.conflict).toBe(true);
      expect(memory.entries).toHaveLength(2);
    });

    test('does not flag agreeing values', () => {
      const selfLive = { memory: [{ source: 'proxmox', kind: 'live', role: 'used', unit: 'bytes', value: 1000000000, observedAt: 1, resourceId: 'host1', resourceName: 'emby' }] };
      const childSvc = { resource: { id: 'svc1', name: 'emby-server', metadata: {} }, live: { memory: [{ source: 'theta-agent', kind: 'live', role: 'used', unit: 'bytes', value: 1020000000, observedAt: 2, resourceId: 'svc1', resourceName: 'emby-server' }] } };

      const { groups } = ResourceFacts.buildResourceFactsMesh({ resource: host, selfLive, children: [childSvc] });
      const memory = groups.find((g) => g.concept === 'memory');
      expect(memory.conflict).toBe(false);
    });

    test('counts children that would need their own fetch without fetching them', () => {
      const { skippedChildrenCount } = ResourceFacts.buildResourceFactsMesh({
        resource: host,
        selfLive: null,
        children: [
          { resource: { id: 's1', name: 'ssh', metadata: {} }, live: null, needsOwnFetch: true },
          { resource: { id: 's2', name: 'theta-agent', metadata: {} }, live: { memory: [] }, needsOwnFetch: false }
        ]
      });
      expect(skippedChildrenCount).toBe(1);
    });

    test('omits empty concept groups', () => {
      const { groups } = ResourceFacts.buildResourceFactsMesh({ resource: { id: 'h', metadata: {} }, selfLive: null, children: [] });
      expect(groups).toEqual([]);
    });
  });
});
