require('./setup');
const { SiteSpoke } = require('../models/site_spoke');
const { nextFreeLdapServerId, ldapHostFor } = require('../utils/ldap_replication');

describe('ldap_replication', () => {
  beforeEach(async () => {
    const all = await SiteSpoke.list();
    for (const s of all) await s.delete();
  });

  describe('ldapHostFor', () => {
    test('derives ldaps://<host>:636 from an http(s) endpoint, ignoring its own port', () => {
      expect(ldapHostFor('https://sso.site2.example.com')).toBe('ldaps://sso.site2.example.com:636');
      expect(ldapHostFor('https://sso.site2.example.com:8443')).toBe('ldaps://sso.site2.example.com:636');
      expect(ldapHostFor('http://sso.site3.example.com')).toBe('ldaps://sso.site3.example.com:636');
    });

    test('returns null for an unparseable endpoint', () => {
      expect(ldapHostFor('not-a-url')).toBeNull();
      expect(ldapHostFor('')).toBeNull();
    });
  });

  describe('nextFreeLdapServerId', () => {
    test('starts at 2 (1 is reserved for the master) when no spokes are registered', async () => {
      await expect(nextFreeLdapServerId()).resolves.toBe(2);
    });

    test('picks the lowest free id, not just the next highest', async () => {
      const now = Math.floor(Date.now() / 1000);
      await SiteSpoke.create({ id: 'a', endpoint: 'https://a.example.com', pushToken: 'tok-a', created_on: now, ldapServerId: 2 });
      await SiteSpoke.create({ id: 'b', endpoint: 'https://b.example.com', pushToken: 'tok-b', created_on: now, ldapServerId: 4 });

      await expect(nextFreeLdapServerId()).resolves.toBe(3);
    });

    test('ignores spokes with no ldapServerId assigned yet', async () => {
      const now = Math.floor(Date.now() / 1000);
      await SiteSpoke.create({ id: 'c', endpoint: 'https://c.example.com', pushToken: 'tok-c', created_on: now });

      await expect(nextFreeLdapServerId()).resolves.toBe(2);
    });
  });
});
