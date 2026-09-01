'use strict';

const ResourceStatus = require('../public/js/resource_status');

describe('resource_status', () => {
  describe('bucketResourceStatus', () => {
    test('uses explicit status when present', () => {
      expect(ResourceStatus.bucketResourceStatus({ metadata: { status: 'ok' } })).toBe('ok');
      expect(ResourceStatus.bucketResourceStatus({ metadata: { status: 'warning' } })).toBe('warning');
      expect(ResourceStatus.bucketResourceStatus({ metadata: { status: 'critical' } })).toBe('critical');
      expect(ResourceStatus.bucketResourceStatus({ metadata: { status: 'error' } })).toBe('critical');
    });

    test('falls back to bubbled_status', () => {
      expect(ResourceStatus.bucketResourceStatus({ metadata: { bubbled_status: 'warning' } })).toBe('warning');
    });

    test('falls back to powerState when neither status field is set', () => {
      expect(ResourceStatus.bucketResourceStatus({ metadata: { powerState: 'running' } })).toBe('ok');
      expect(ResourceStatus.bucketResourceStatus({ metadata: { powerState: 'stopped' } })).toBe('warning');
    });

    test('unknown when nothing is available', () => {
      expect(ResourceStatus.bucketResourceStatus({ metadata: {} })).toBe('unknown');
      expect(ResourceStatus.bucketResourceStatus({ metadata: { powerState: 'paused' } })).toBe('unknown');
      expect(ResourceStatus.bucketResourceStatus({})).toBe('unknown');
    });
  });

  describe('bucketResourceStatuses', () => {
    test('counts a list into all four buckets', () => {
      const counts = ResourceStatus.bucketResourceStatuses([
        { metadata: { status: 'ok' } },
        { metadata: { status: 'ok' } },
        { metadata: { status: 'warning' } },
        { metadata: { status: 'critical' } },
        { metadata: {} }
      ]);
      expect(counts).toEqual({ ok: 2, warning: 1, critical: 1, unknown: 1 });
    });

    test('empty list is all zero', () => {
      expect(ResourceStatus.bucketResourceStatuses([])).toEqual({ ok: 0, warning: 0, critical: 0, unknown: 0 });
    });
  });

  describe('serviceActiveState', () => {
    // The direct regression test for the live bug: the Theta Agent service's
    // own Status card showed a green "Active" badge next to "State:
    // inactive" -- same undefined value, two different truthy checks.
    test('undefined active is unknown, not active', () => {
      expect(ResourceStatus.serviceActiveState(undefined)).toBe('unknown');
      expect(ResourceStatus.serviceActiveState({})).toBe('unknown');
      expect(ResourceStatus.serviceActiveState({ active: undefined })).toBe('unknown');
    });

    test('explicit true/false map directly', () => {
      expect(ResourceStatus.serviceActiveState({ active: true })).toBe('active');
      expect(ResourceStatus.serviceActiveState({ active: false })).toBe('inactive');
    });
  });

  describe('childrenOf', () => {
    test('resolves child resources from edges', () => {
      const resourcesById = { a: { id: 'a' }, b: { id: 'b' }, c: { id: 'c' } };
      const edges = [
        { parentId: 'x', childId: 'a' },
        { parentId: 'x', childId: 'b' },
        { parentId: 'y', childId: 'c' }
      ];
      expect(ResourceStatus.childrenOf('x', edges, resourcesById)).toEqual([resourcesById.a, resourcesById.b]);
    });

    test('drops edges that point at a resource not in resourcesById', () => {
      const edges = [{ parentId: 'x', childId: 'missing' }];
      expect(ResourceStatus.childrenOf('x', edges, {})).toEqual([]);
    });

    test('empty for a resource with no children', () => {
      expect(ResourceStatus.childrenOf('x', [], {})).toEqual([]);
    });
  });
});
