require('./setup');
const { SiteSpoke } = require('../models/site_spoke');
const { nextFreeLdapServerId, ldapMeshHost, ldapHostFor, ldapHostForSpoke } = require('../utils/ldap_replication');

describe('ldap_replication', () => {
  beforeEach(async () => {
    const all = await SiteSpoke.list();
    for (const s of all) await s.delete();
  });

  describe('ldapMeshHost', () => {
    test('a site directory is dialled at its mesh address over plain LDAP', () => {
      expect(ldapMeshHost(1)).toBe('ldap://10.1.0.2:389');
      expect(ldapMeshHost(5)).toBe('ldap://10.5.0.2:389');
    });

    test('rejects a missing or invalid site id', () => {
      expect(ldapMeshHost(null)).toBeNull();
      expect(ldapMeshHost(0)).toBeNull();
      expect(ldapMeshHost('x')).toBeNull();
    });
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

  describe('ldapHostForSpoke', () => {
    test('prefers the mesh address over plain LDAP for any spoke with a ServerID', () => {
      expect(ldapHostForSpoke({ ldapServerId: 2, endpoint: 'https://spoke.example.com' }))
        .toBe('ldap://10.2.0.2:389');
    });

    test('falls back to the public endpoint when the spoke has no ServerID yet', () => {
      expect(ldapHostForSpoke({ endpoint: 'https://spoke.example.com' }))
        .toBe('ldaps://spoke.example.com:636');
    });

    test('returns null for a null spoke', () => {
      expect(ldapHostForSpoke(null)).toBeNull();
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

  // The staleness that actually bites: not the ServerID (which only moves on
  // promotion), but the peer list, which goes stale on every node in the
  // cluster each time any new site joins. /resync only re-pulls the catalog,
  // and site-ldap-register.js only runs from setup.sh.
  describe('replicationDrift', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    let confPath;

    function writeConf(serverId, providers) {
      const blocks = providers.map((p, i) => `syncrepl rid=${i + 1}\n  provider=${p}\n  type=refreshAndPersist\n`).join('\n');
      fs.writeFileSync(confPath, `ServerID ${serverId}\n\n${blocks}`);
    }

    beforeEach(() => {
      confPath = path.join(os.tmpdir(), `slapd-drift-${Math.random().toString(36).slice(2)}.conf`);
      process.env.SLAPD_CONF_PATH = confPath;
      jest.resetModules();
    });

    afterEach(() => {
      try { fs.unlinkSync(confPath); } catch (e) { /* already gone */ }
      delete process.env.SLAPD_CONF_PATH;
      jest.resetModules();
    });

    const load = () => require('../utils/ldap_replication');

    test('reports in-sync when slapd matches what the cluster advertises', () => {
      writeConf(1, ['ldaps://spoke-a:636', 'ldaps://spoke-b:636']);
      const d = load().replicationDrift({
        advertisedServerId: 1,
        advertisedPeers: [{ ldapHost: 'ldaps://spoke-a:636' }, { ldapHost: 'ldaps://spoke-b:636' }]
      });
      expect(d.stale).toBe(false);
      expect(d.peersStale).toBe(false);
      expect(d.serverIdStale).toBe(false);
      expect(d.missingPeers).toEqual([]);
    });

    test('flags a peer the cluster has but this node has not been reconfigured for', () => {
      writeConf(1, ['ldaps://spoke-a:636']);
      const d = load().replicationDrift({
        advertisedServerId: 1,
        advertisedPeers: [{ ldapHost: 'ldaps://spoke-a:636' }, { ldapHost: 'ldaps://spoke-b:636' }]
      });
      expect(d.stale).toBe(true);
      expect(d.peersStale).toBe(true);
      expect(d.missingPeers).toEqual(['ldaps://spoke-b:636']);
      expect(d.extraPeers).toEqual([]);
    });

    test('flags a peer that has been removed from the cluster but is still configured', () => {
      writeConf(1, ['ldaps://spoke-a:636', 'ldaps://gone:636']);
      const d = load().replicationDrift({
        advertisedServerId: 1,
        advertisedPeers: [{ ldapHost: 'ldaps://spoke-a:636' }]
      });
      expect(d.peersStale).toBe(true);
      expect(d.extraPeers).toEqual(['ldaps://gone:636']);
    });

    test('flags a ServerID that has not been applied yet (post-promotion)', () => {
      writeConf(3, []);
      const d = load().replicationDrift({ advertisedServerId: 1, advertisedPeers: [] });
      expect(d.serverIdStale).toBe(true);
      expect(d.stale).toBe(true);
      expect(d.configuredServerId).toBe(3);
    });

    test('an unreadable slapd.conf reports unknown, never "in sync"', () => {
      process.env.SLAPD_CONF_PATH = path.join(os.tmpdir(), 'definitely-not-here.conf');
      jest.resetModules();
      const d = load().replicationDrift({ advertisedServerId: 1, advertisedPeers: [{ ldapHost: 'ldaps://x:636' }] });
      expect(d.stale).toBeNull();
      expect(d.peersStale).toBeNull();
      expect(d.configuredPeers).toBeNull();
    });
  });
});

// Concurrent registration used to hand two spokes the SAME ServerID: the
// allocate-then-create sequence is a read-then-write, and both callers read
// the same used-set. Duplicate ServerIDs don't fail loudly, they quietly break
// MMR (ServerID is how syncrepl tells originators apart). Seen for real with
// two simultaneous POST /api/site/spokes calls, both assigned id 2.
describe('concurrent ServerID allocation', () => {
  const { withLock } = require('../utils/mutex');

  beforeEach(async () => {
    const all = await SiteSpoke.list();
    for (const s of all) await s.delete();
  });

  test('two simultaneous registrations get distinct ids under the lock', async () => {
    const register = (endpoint) => withLock('site-spoke-register', async () => {
      const id = await nextFreeLdapServerId();
      // Widen the read-then-write window so an unserialized version fails
      // reliably rather than by luck.
      await new Promise((r) => setTimeout(r, 20));
      return SiteSpoke.create({
        id: endpoint, endpoint, pushToken: 'tok-' + endpoint,
        created_on: Math.floor(Date.now() / 1000), ldapServerId: id
      });
    });

    const [a, b] = await Promise.all([
      register('https://a.example.com'),
      register('https://b.example.com')
    ]);

    expect(a.ldapServerId).not.toBe(b.ldapServerId);
    expect([a.ldapServerId, b.ldapServerId].sort()).toEqual([2, 3]);
  });

  // The lock is a convenience; the guarantee is a unique index (models/index.js
  // ensureUniqueIndexes), because the lock is process-local and protects
  // nothing if this app is ever run as two processes against one database.
  // So the unserialized race must still fail — loudly, at the database —
  // rather than quietly writing the duplicate that breaks MMR.
  test('without the lock the database refuses the duplicate (guards the guard)', async () => {
    const registerUnlocked = async (endpoint) => {
      const id = await nextFreeLdapServerId();
      await new Promise((r) => setTimeout(r, 20));
      return SiteSpoke.create({
        id: endpoint, endpoint, pushToken: 'tok-' + endpoint,
        created_on: Math.floor(Date.now() / 1000), ldapServerId: id
      });
    };

    const attempt = Promise.all([
      registerUnlocked('https://c.example.com'),
      registerUnlocked('https://d.example.com')
    ]);

    await expect(attempt).rejects.toThrow(/unique|constraint|validation/i);

    // Exactly one of the two landed: the write is rejected, not half-applied.
    const survivors = (await SiteSpoke.list()).filter((s) => s.ldapServerId === 2);
    expect(survivors.length).toBe(1);
  });
});
