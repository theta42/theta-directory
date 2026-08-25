'use strict';

// Offline replica seeding (utils/ldap_seed.js).
//
// The bug being fixed destroyed data on the MASTER, so these lean on the two
// properties that keep that from happening again: the dump must arrive with
// its identity attributes intact, and a failure must never leave this node
// without a directory.

const os = require('os');
const path = require('path');
const seed = require('../utils/ldap_seed');
const io = seed.__io;

const DUMP = [
  'dn: dc=theta42,dc=com',
  'objectClass: dcObject',
  'dc: theta42',
  'entryUUID: 11111111-1111-1111-1111-111111111111',
  'entryCSN: 20260824205319.305724Z#000000#001#000000',
  '',
  'dn: cn=god_admin,ou=groups,dc=theta42,dc=com',
  'cn: god_admin',
  'member: cn=wmantly,ou=people,dc=theta42,dc=com',
  'entryUUID: 22222222-2222-2222-2222-222222222222',
  'entryCSN: 20260824205324.702552Z#000000#001#000000',
  ''
].join('\n');

function harness(overrides = {}) {
  const calls = { exec: [], renamed: [], removed: [], spawned: [], killed: [], written: [] };
  const files = new Map();
  const dirs = {
    '/proc': ['1', '66', 'self', 'cpuinfo'],
    '/etc/openldap/slapd.d/cn=config': ['olcDatabase={1}mdb.ldif', 'cn=schema.ldif'],
    '/var/lib/ldap': ['data.mdb', 'lock.mdb', 'slapd.log', 'auditlog.ldif'],
  };
  // /proc/<pid>/cmdline is NUL-separated; built by join so the literal cannot
  // be misread as an octal escape ('\0' followed by a digit).
  const NUL = '\u0000';
  files.set('/proc/66/cmdline', [
    'slapd', '-d', '256', '-u', 'ldap', '-g', 'ldap',
    '-F', '/etc/openldap/slapd.d', '-h', 'ldap:/// ldaps:///'
  ].join(NUL) + NUL);
  files.set('/proc/1/cmdline', ['node', '/app/nodejs/bin/www'].join(NUL) + NUL);
  files.set('/etc/openldap/slapd.d/cn=config/olcDatabase={1}mdb.ldif', 'olcDatabase: {1}mdb\nolcDbDirectory: /var/lib/ldap\n');

  const saved = { ...io };
  Object.assign(io, {
    readdir: async (p) => {
      if (dirs[p]) return dirs[p];
      if (String(p).startsWith(require('os').tmpdir())) return [];
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    readFile: async (p) => {
      if (files.has(p)) return files.get(p);
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFile: async (p, d) => { calls.written.push(p); files.set(p, d); },
    rename: async (a, b) => { calls.renamed.push([a, b]); },
    mkdir: async () => {},
    rm: async (p) => { calls.removed.push(p); },
    kill: (pid, sig) => {
      calls.killed.push([pid, sig]);
      if (sig === 0) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    },
    spawnDetached: (cmd, argv) => { calls.spawned.push([cmd, ...argv]); return 999; },
    sleep: async () => {},
    execFile: async (cmd, argv) => {
      calls.exec.push([cmd, ...(argv || [])]);
      return { stdout: '', stderr: '' };
    },
    ...overrides,
  });
  return { calls, files, dirs, restore: () => Object.assign(io, saved) };
}

describe('seedFromMasterLdif input guards', () => {
  test('refuses a dump whose operational attributes were stripped', async () => {
    const h = harness();
    try {
      // Exactly what the old ldapadd path produced: valid entries, no identity.
      const stripped = DUMP.split('\n').filter((l) => !/^entry(UUID|CSN):/.test(l)).join('\n');
      await expect(seed.seedFromMasterLdif(stripped, { baseDn: 'dc=theta42,dc=com' }))
        .rejects.toThrow(/entryUUID/);
      expect(h.calls.killed).toHaveLength(0); // never touched slapd
    } finally { h.restore(); }
  });

  test('refuses an empty dump rather than wiping the directory', async () => {
    const h = harness();
    try {
      await expect(seed.seedFromMasterLdif('', { baseDn: 'dc=theta42,dc=com' })).rejects.toThrow(/empty dump/);
      await expect(seed.seedFromMasterLdif('# just a comment\n', { baseDn: 'dc=theta42,dc=com' })).rejects.toThrow(/no entries/);
      expect(h.calls.renamed).toHaveLength(0);
    } finally { h.restore(); }
  });

  test('requires a baseDn', async () => {
    const h = harness();
    try {
      await expect(seed.seedFromMasterLdif(DUMP, {})).rejects.toThrow(/baseDn is required/);
    } finally { h.restore(); }
  });
});

describe('seedFromMasterLdif happy path', () => {
  test('stops slapd, replaces the database, restarts it with the same argv', async () => {
    const h = harness();
    try {
      const out = await seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' });
      expect(out.seeded).toBe(true);
      expect(out.entries).toBe(2);

      expect(h.calls.killed[0]).toEqual([66, 'SIGTERM']);

      const slapadd = h.calls.exec.find((c) => c[0] === 'slapadd');
      expect(slapadd).toBeTruthy();
      expect(slapadd).toContain('-b');
      expect(slapadd).toContain('dc=theta42,dc=com');
      expect(slapadd).toContain('/etc/openldap/slapd.d');

      // slapd runs as ldap and cannot open a database owned by root.
      expect(h.calls.exec.some((c) => c[0] === 'chown')).toBe(true);

      // Restarted from the ORIGINAL argv, not a reconstructed guess.
      expect(h.calls.spawned[0]).toEqual([
        'slapd', '-d', '256', '-u', 'ldap', '-g', 'ldap',
        '-F', '/etc/openldap/slapd.d', '-h', 'ldap:/// ldaps:///'
      ]);

      // And it waited for the directory to actually answer.
      expect(h.calls.exec.some((c) => c[0] === 'ldapsearch')).toBe(true);
    } finally { h.restore(); }
  });

  test('moves only the mdb files aside, never the logs', async () => {
    const h = harness();
    try {
      await seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' });
      const movedNames = h.calls.renamed.map(([from]) => path.basename(from));
      expect(movedNames.sort()).toEqual(['data.mdb', 'lock.mdb']);
      // slapd.log and auditlog.ldif are the record of what happened; losing
      // them at exactly the moment something went wrong is the worst time.
      expect(movedNames).not.toContain('slapd.log');
      expect(movedNames).not.toContain('auditlog.ldif');
    } finally { h.restore(); }
  });

  test('stashes the old database inside the data directory, not in /tmp', async () => {
    // Regression. The stash used to be os.tmpdir(), and the data directory is
    // a volume mount in every deployment we ship -- so rename(2) crossed a
    // filesystem boundary and the very first real spoke join died with
    // "EXDEV: cross-device link not permitted, rename '/var/lib/ldap/data.mdb'
    // -> '/tmp/ldap-preseed-<uuid>/data.mdb'" before moving a single file.
    // A stash under the data directory is on its filesystem by construction.
    const h = harness();
    try {
      await seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' });
      const aside = h.calls.renamed.filter(([from]) => path.dirname(String(from)) === '/var/lib/ldap');
      expect(aside).toHaveLength(2);
      for (const [, to] of aside) {
        expect(String(to).startsWith('/var/lib/ldap/')).toBe(true);
        expect(String(to).startsWith(os.tmpdir() + path.sep)).toBe(false);
        // Dot-prefixed so it stays out of the way of anything listing the
        // directory; slapd only ever opens data.mdb and lock.mdb by name.
        expect(path.basename(path.dirname(String(to)))).toMatch(/^\.ldap-preseed-/);
      }
    } finally { h.restore(); }
  });

  test('falls back to copy+unlink when a move does cross a filesystem', async () => {
    // A data directory assembled from several mounts is somebody's legitimate
    // choice; EXDEV must not fail the join.
    const copied = [];
    const h = harness({
      rename: async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); },
      copyFile: async (a, b) => { copied.push([a, b]); },
    });
    try {
      await seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' });
      expect(copied.map(([from]) => path.basename(from)).sort()).toEqual(['data.mdb', 'lock.mdb']);
      // And the source is unlinked, or the "moved" file is still in place and
      // slapadd would be writing alongside the old database.
      for (const [from] of copied) expect(h.calls.removed).toContain(from);
    } finally { h.restore(); }
  });

  test('a move failure that is not EXDEV is not papered over', async () => {
    const h = harness({
      rename: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
      copyFile: async () => { throw new Error('copyFile should not be reached'); },
    });
    try {
      await expect(seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' }))
        .rejects.toThrow(/EACCES/);
    } finally { h.restore(); }
  });

  test('the dump is written 0600 -- it carries every password hash', async () => {
    let mode = null;
    const h = harness({
      writeFile: async (p, d, o) => { mode = o && o.mode; },
    });
    try {
      await seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' });
      expect(mode).toBe(0o600);
    } finally { h.restore(); }
  });
});

describe('seedFromMasterLdif failure handling', () => {
  test('a failed slapadd restores the old database and restarts slapd', async () => {
    const h = harness({
      execFile: async (cmd, argv) => {
        if (cmd === 'slapadd') throw new Error('slapadd: could not add entry');
        return { stdout: '', stderr: '' };
      },
    });
    try {
      await expect(seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' }))
        .rejects.toThrow(/previous directory was restored/);

      // Moved aside, then moved back. Matched on the parent directory rather
      // than a prefix: the stash is now a CHILD of the data directory, so a
      // prefix test would also match the moves that put the files there.
      const back = h.calls.renamed.filter(([, to]) => path.dirname(String(to)) === '/var/lib/ldap');
      expect(back.map(([, to]) => path.basename(to)).sort()).toEqual(['data.mdb', 'lock.mdb']);

      // The one state this must never leave behind is a node with no directory.
      expect(h.calls.spawned.length).toBeGreaterThan(0);
    } finally { h.restore(); }
  });

  test('refuses when no running slapd can be found, without touching anything', async () => {
    const h = harness();
    h.dirs['/proc'] = ['1'];   // only the node process
    try {
      await expect(seed.seedFromMasterLdif(DUMP, { baseDn: 'dc=theta42,dc=com' }))
        .rejects.toThrow(/could not find the running slapd/);
      expect(h.calls.renamed).toHaveLength(0);
      expect(h.calls.killed).toHaveLength(0);
    } finally { h.restore(); }
  });
});

describe('discovery helpers', () => {
  test('finds slapd by argv[0] basename, not by matching any process', async () => {
    const h = harness();
    try {
      const proc = await seed.findSlapdProcess();
      expect(proc.pid).toBe(66);
      expect(proc.argv[0]).toBe('slapd');
    } finally { h.restore(); }
  });

  test('reads the database directory from the live config, never hardcoded', async () => {
    const h = harness();
    h.files.set('/etc/openldap/slapd.d/cn=config/olcDatabase={1}mdb.ldif',
      'olcDatabase: {1}mdb\nolcDbDirectory: /srv/ldap-data\n');
    try {
      // Wiping a guessed path would destroy the wrong thing AND leave the real
      // directory in place -- the worst of both.
      expect(await seed.dataDirFromConfig('/etc/openldap/slapd.d')).toBe('/srv/ldap-data');
    } finally { h.restore(); }
  });

  test('counts entries for the audit note', () => {
    expect(seed.countEntries(DUMP)).toBe(2);
    expect(seed.countEntries('')).toBe(0);
  });
});

// The unit tests above drive a mocked io. These use the REAL filesystem, because
// the bug they cover was in the interaction with it: fs.rename returns EXDEV
// across a mount, and -- unlike the mv(1) an operator would reach for while
// testing by hand, which silently falls back to copy+unlink -- Node does not.
describe('moveDatabaseAside/restoreDatabase against a real filesystem', () => {
  const fs = require('fs');
  const realOs = require('os');

  function realDataDir() {
    const dir = fs.mkdtempSync(path.join(realOs.tmpdir(), 'ldapseed-'));
    fs.writeFileSync(path.join(dir, 'data.mdb'), 'DATA');
    fs.writeFileSync(path.join(dir, 'lock.mdb'), 'LOCK');
    fs.writeFileSync(path.join(dir, 'slapd.log'), 'LOG');
    fs.writeFileSync(path.join(dir, 'auditlog.ldif'), 'AUDIT');
    return dir;
  }

  test('round-trips the database and leaves the logs where they were', async () => {
    const dir = realDataDir();
    try {
      const backup = await seed.moveDatabaseAside(dir);
      // The stash must be inside the data directory -- that is what makes the
      // rename same-filesystem whatever the directory is mounted from.
      expect(path.dirname(backup.stash)).toBe(dir);
      expect(fs.existsSync(path.join(dir, 'data.mdb'))).toBe(false);
      expect(fs.existsSync(path.join(backup.stash, 'data.mdb'))).toBe(true);
      // Logs are the record of what happened; losing them at the moment
      // something goes wrong is the worst possible time.
      expect(fs.readFileSync(path.join(dir, 'slapd.log'), 'utf8')).toBe('LOG');
      expect(fs.readFileSync(path.join(dir, 'auditlog.ldif'), 'utf8')).toBe('AUDIT');

      await seed.restoreDatabase(dir, backup);
      expect(fs.readFileSync(path.join(dir, 'data.mdb'), 'utf8')).toBe('DATA');
      expect(fs.readFileSync(path.join(dir, 'lock.mdb'), 'utf8')).toBe('LOCK');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('restore replaces whatever a failed slapadd left behind', async () => {
    const dir = realDataDir();
    try {
      const backup = await seed.moveDatabaseAside(dir);
      fs.writeFileSync(path.join(dir, 'data.mdb'), 'HALF-BUILT');
      await seed.restoreDatabase(dir, backup);
      expect(fs.readFileSync(path.join(dir, 'data.mdb'), 'utf8')).toBe('DATA');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('moveFile copies across a filesystem boundary rather than failing', async () => {
    // Simulated by making rename report EXDEV; the fallback itself runs for
    // real against the filesystem.
    const dir = realDataDir();
    const saved = seed.__io.rename;
    seed.__io.rename = async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); };
    try {
      const dest = path.join(dir, 'moved.mdb');
      await seed.moveFile(path.join(dir, 'data.mdb'), dest);
      expect(fs.readFileSync(dest, 'utf8')).toBe('DATA');
      expect(fs.existsSync(path.join(dir, 'data.mdb'))).toBe(false);
    } finally {
      seed.__io.rename = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
