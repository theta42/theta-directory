'use strict';

// Pure-function tests for the shared resource-identity matcher extracted from
// discovery_reconciler.js. No ORM needed -- findExistingMatch operates on
// plain objects.

const {
  normalizeMac,
  normalizeIdentityHost,
  hasStrongIdentity,
  findExistingMatch
} = require('../services/resource_matcher');

describe('resource_matcher', () => {
  describe('normalizeMac / normalizeIdentityHost', () => {
    test('normalizeMac strips separators and lowercases', () => {
      expect(normalizeMac('6E:65:DF:28:BB:21')).toBe('6e65df28bb21');
      expect(normalizeMac('6e-65-df-28-bb-21')).toBe('6e65df28bb21');
      expect(normalizeMac(null)).toBe('');
    });

    test('normalizeIdentityHost takes only the first dot-label', () => {
      expect(normalizeIdentityHost('web01.example.com')).toBe('web01');
      expect(normalizeIdentityHost('EMBY')).toBe('emby');
      expect(normalizeIdentityHost(null)).toBe('');
    });
  });

  describe('findExistingMatch tiers', () => {
    test('tier 1: matches by id above everything else', () => {
      const pool = [
        { id: 'a', name: 'wrong-name', metadata: {} },
        { id: 'b', name: 'right-id', metadata: {} }
      ];
      const match = findExistingMatch({ id: 'b', name: 'wrong-name', metadata: {} }, pool);
      expect(match.id).toBe('b');
    });

    test('tier 2: matches by MAC address regardless of name', () => {
      const pool = [
        { id: 'a', name: 'emby', metadata: { macAddress: '11:11:11:11:11:11' } },
        { id: 'b', name: 'not-emby', metadata: { macAddress: '6e:65:df:28:bb:21' } }
      ];
      const match = findExistingMatch(
        { name: 'emby', metadata: { macAddress: '6E:65:DF:28:BB:21' } },
        pool
      );
      expect(match.id).toBe('b');
    });

    test('tier 2: matches a MAC found in an interfaces array', () => {
      const pool = [
        { id: 'a', metadata: { interfaces: [{ mac: '6e:65:df:28:bb:21', ip: '192.168.1.206' }] } }
      ];
      const match = findExistingMatch({ metadata: { macAddress: '6e65df28bb21' } }, pool);
      expect(match.id).toBe('a');
    });

    test('tier 3: falls back to IP when no MAC present on either side', () => {
      const pool = [{ id: 'a', metadata: { ip: '192.168.1.206' } }];
      const match = findExistingMatch({ metadata: { ip: '192.168.1.206' } }, pool);
      expect(match.id).toBe('a');
    });

    test('tier 3: never hijacks a candidate that already has a MAC (the guard)', () => {
      const pool = [
        { id: 'a', metadata: { ip: '192.168.1.206', macAddress: 'aa:aa:aa:aa:aa:aa' } }
      ];
      const match = findExistingMatch({ metadata: { ip: '192.168.1.206' } }, pool);
      expect(match).toBeNull();
    });

    test('tier 4: falls back to name/slug only when incoming has neither MAC nor IP', () => {
      const pool = [{ id: 'a', name: 'emby', slug: 'lxc-emby-6e65df28bb21', metadata: {} }];
      const match = findExistingMatch({ name: 'emby', metadata: {} }, pool);
      expect(match.id).toBe('a');
    });

    test('tier 4: an unmatched MAC does not fall through to a name guess', () => {
      // Incoming carries a MAC that matches nothing -- a stronger negative
      // signal than never having had one. Must not then match by name.
      const pool = [{ id: 'a', name: 'emby', metadata: {} }];
      const match = findExistingMatch(
        { name: 'emby', metadata: { macAddress: 'ff:ff:ff:ff:ff:ff' } },
        pool
      );
      expect(match).toBeNull();
    });

    test('tier 4: an unmatched IP does not fall through to a name guess either', () => {
      const pool = [{ id: 'a', name: 'emby', metadata: {} }];
      const match = findExistingMatch(
        { name: 'emby', metadata: { ip: '10.0.0.99' } },
        pool
      );
      expect(match).toBeNull();
    });
  });

  describe('site scoping', () => {
    const siteOf = (id) => ({ a: 'site1', b: 'site2' }[id] || null);

    test('IP tier only matches within the same site', () => {
      const pool = [{ id: 'a', metadata: { ip: '192.168.1.206' } }];
      const sameSite = findExistingMatch(
        { metadata: { ip: '192.168.1.206' } },
        pool,
        { siteOf, incomingSiteId: 'site1' }
      );
      expect(sameSite.id).toBe('a');

      const otherSite = findExistingMatch(
        { metadata: { ip: '192.168.1.206' } },
        pool,
        { siteOf, incomingSiteId: 'site2' }
      );
      expect(otherSite).toBeNull();
    });

    test('name/slug tier only matches within the same site', () => {
      const pool = [{ id: 'a', name: 'emby', metadata: {} }];
      const otherSite = findExistingMatch(
        { name: 'emby', metadata: {} },
        pool,
        { siteOf, incomingSiteId: 'site2' }
      );
      expect(otherSite).toBeNull();
    });

    test('MAC tier is never site-scoped -- a device can move sites', () => {
      const pool = [{ id: 'a', metadata: { macAddress: '6e:65:df:28:bb:21' } }];
      const match = findExistingMatch(
        { metadata: { macAddress: '6e65df28bb21' } },
        pool,
        { siteOf, incomingSiteId: 'site2' }
      );
      expect(match.id).toBe('a');
    });
  });

  describe('hasStrongIdentity', () => {
    test('true for a resource with a macAddress or an interface MAC', () => {
      expect(hasStrongIdentity({ metadata: { macAddress: 'aa:aa:aa:aa:aa:aa' } })).toBe(true);
      expect(hasStrongIdentity({ metadata: { interfaces: [{ mac: 'aa:aa:aa:aa:aa:aa' }] } })).toBe(true);
    });

    test('false for a resource with only an IP or name', () => {
      expect(hasStrongIdentity({ metadata: { ip: '192.168.1.1' } })).toBe(false);
      expect(hasStrongIdentity({ metadata: {} })).toBe(false);
      expect(hasStrongIdentity({})).toBe(false);
    });
  });
});
