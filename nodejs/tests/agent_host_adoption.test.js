'use strict';

// A self-enrolling agent must ADOPT the host resource its machine already has,
// not mint a second one.
//
// The regression: Agent.enroll({ siteId }) created a host unconditionally, with
// a random hex suffix on the slug. Every install seeded by bootstrap.js already
// has a host resource for the stack machine, so a fresh deployment came up with
// two hosts of the same name under the same site -- one carrying every service,
// the other carrying only the agent. Nothing reconciled them, and the random
// suffix meant re-enrolling forked a third.

const { hostSlugCandidates } = require('../utils/agent_binding');

describe('agent host adoption', () => {
  describe('hostSlugCandidates', () => {
    test('accepts both seeded slug conventions', () => {
      // bootstrap.js writes `host_<slug>`; the agent enrolment path writes
      // `host-<slug>`. A machine must be recognised whichever seeded it.
      const c = hostSlugCandidates('theta-suite-718it');
      expect(c).toContain('host_theta-suite-718it');
      expect(c).toContain('host-theta-suite-718it');
    });

    test('slugifies the way the seed paths do', () => {
      expect(hostSlugCandidates('Theta Suite 718IT'))
        .toContain('host_theta-suite-718it');
      expect(hostSlugCandidates('web01.example.com'))
        .toContain('host_web01-example-com');
    });

    test('is empty for a nameless host, so nothing matches by accident', () => {
      expect(hostSlugCandidates('')).toEqual([]);
      expect(hostSlugCandidates(null)).toEqual([]);
      expect(hostSlugCandidates('!!!')).toEqual([]);
    });
  });

  describe('findHostAtSite', () => {
    const load = (resources, edges) => {
      jest.resetModules();
      jest.doMock('../models/resource', () => ({
        Resource: { get: async (id) => resources.find(r => r.id === id) || null },
        ResourceEdge: { list: async ({ where }) => edges.filter(e => e.parentId === where.parentId) }
      }));
      return require('../utils/agent_binding').findHostAtSite;
    };

    const site = { id: 'site1', kind: 'site', slug: 'site_718it', name: '718it' };
    const seeded = { id: 'h1', kind: 'host', slug: 'host_theta-suite-718it', name: 'theta-suite-718it' };

    afterEach(() => { jest.resetModules(); jest.dontMock('../models/resource'); });

    test('adopts the host bootstrap already seeded, by name', async () => {
      const find = load([site, seeded], [{ parentId: 'site1', childId: 'h1' }]);
      await expect(find('site1', 'theta-suite-718it')).resolves.toMatchObject({ id: 'h1' });
    });

    test('matches case-insensitively', async () => {
      const find = load([site, seeded], [{ parentId: 'site1', childId: 'h1' }]);
      await expect(find('site1', 'THETA-Suite-718IT')).resolves.toMatchObject({ id: 'h1' });
    });

    test('matches on slug when the display name differs', async () => {
      const renamed = { ...seeded, name: 'Stack Host' };
      const find = load([site, renamed], [{ parentId: 'site1', childId: 'h1' }]);
      await expect(find('site1', 'theta-suite-718it')).resolves.toMatchObject({ id: 'h1' });
    });

    test('returns null for a machine that is genuinely new', async () => {
      const find = load([site, seeded], [{ parentId: 'site1', childId: 'h1' }]);
      await expect(find('site1', 'some-other-box')).resolves.toBeNull();
    });

    test('never adopts a service or a site that shares the name', async () => {
      const svc = { id: 's1', kind: 'service', slug: 'svc-x', name: 'theta-suite-718it' };
      const find = load([site, svc], [{ parentId: 'site1', childId: 's1' }]);
      await expect(find('site1', 'theta-suite-718it')).resolves.toBeNull();
    });

    test('the same hostname at another site is a different machine', async () => {
      const other = { id: 'site2', kind: 'site', slug: 'site_other' };
      const find = load([site, other, seeded], [{ parentId: 'site1', childId: 'h1' }]);
      await expect(find('site2', 'theta-suite-718it')).resolves.toBeNull();
    });

    test('a missing site or name adopts nothing', async () => {
      const find = load([site, seeded], [{ parentId: 'site1', childId: 'h1' }]);
      await expect(find(null, 'theta-suite-718it')).resolves.toBeNull();
      await expect(find('site1', '')).resolves.toBeNull();
    });
  });
});
