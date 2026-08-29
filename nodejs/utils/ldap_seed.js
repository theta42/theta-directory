'use strict';

// Offline replica seeding for a spoke's LDAP tree.
//
// THE BUG THIS EXISTS TO FIX
//
// A spoke used to adopt the master's directory with `ldapadd -c`, on top of
// the tree its own container entrypoint had already seeded minutes earlier.
// Two consequences, and the second one destroys data on the MASTER:
//
//   1. `ldapadd` cannot modify an entry that already exists; it returns error
//      68 and moves on. Every DN the entrypoint seeds -- the base DN, ou=people,
//      ou=groups, cn=admin, and the five global groups `god_admin`,
//      `app_sso_admin`, `app_sso_invite`, `app_sso_oauth_admin`,
//      `app_sso_service_account` -- was therefore SKIPPED. The master's version
//      of those entries, memberships and all, never reached the spoke. The
//      import reported this as success: "imported (N entries already present,
//      skipped)".
//
//   2. Every entry that DID import was re-CREATED locally, so it got a fresh
//      entryUUID and a brand-new entryCSN. Multi-provider replication is then
//      switched on. syncrepl resolves by CSN, and the spoke's minutes-old
//      entries are newer than the master's -- so the spoke's copy propagates
//      BACKWARDS and overwrites the master's.
//
// Together: joining a spoke silently reset the master's global groups to the
// spoke's bootstrap defaults. Observed on a live pair -- `god_admin` on the
// master went from its real membership to just `cn=admin`, and the master's
// whole ou=people was torn down and re-added underneath a logged-in user.
//
// WHY SEEDING OFFLINE IS THE FIX AND NOT A WORKAROUND
//
// This is how OpenLDAP replicas have always been meant to be brought up. A
// replica is a COPY, not a re-entry of the same data: entryUUID is the identity
// syncrepl matches on and entryCSN is how it orders changes, so both must
// arrive intact. Only `slapadd` can write them, and only with slapd stopped.
// Re-creating entries over LDAP necessarily mints new ones, which is what makes
// a fresh spoke look newer than the master it just copied.
//
// Seeding from the master's dump verbatim also removes the skip problem for
// free: there is nothing to collide with, because the local tree is replaced
// rather than merged into.
//
// SAFETY
//
// slapd is started by docker-entrypoint.sh as a background child and then
// orphaned when the entrypoint `exec`s the app, so nothing supervises or
// restarts it. Stopping it here is safe, and putting it back is entirely our
// responsibility -- so the existing database is moved aside rather than
// deleted, and any failure restores it and restarts slapd before rethrowing.
// The one state this must never leave behind is a spoke with no directory.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Injectable so tests can drive the whole sequence without a real slapd.
const io = {
  execFile: execFileAsync,
  readFile: (p, enc) => fs.promises.readFile(p, enc),
  readdir: (p) => fs.promises.readdir(p),
  rename: (a, b) => fs.promises.rename(a, b),
  mkdir: (p) => fs.promises.mkdir(p, { recursive: true }),
  rm: (p) => fs.promises.rm(p, { recursive: true, force: true }),
  copyFile: (a, b) => fs.promises.copyFile(a, b),
  writeFile: (p, d, o) => fs.promises.writeFile(p, d, o),
  kill: (pid, sig) => process.kill(pid, sig),
  spawnDetached: null, // set below; kept on io so tests can replace it
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const { spawn } = require('child_process');
io.spawnDetached = (cmd, argv, opts) => {
  const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', ...opts });
  child.unref();
  return child.pid;
};

const SLAPD_CONFIG_DIR = '/etc/openldap/slapd.d';

// findSlapdProcess reads /proc rather than shelling out to `ps`, whose flag
// spelling differs between the busybox in this image and procps elsewhere.
// The argv is what we relaunch with: reusing the exact command line the
// entrypoint used is the only way to be sure the restarted slapd listens on the
// same sockets with the same config as the one we stopped.
async function findSlapdProcess() {
  let entries;
  try {
    entries = await io.readdir('/proc');
  } catch (e) {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    let raw;
    try {
      raw = await io.readFile(`/proc/${name}/cmdline`, 'utf8');
    } catch (e) {
      continue; // vanished between readdir and read, or not ours
    }
    const argv = raw.split('\0').filter(Boolean);
    if (!argv.length) continue;
    if (path.basename(argv[0]) !== 'slapd') continue;
    return { pid: Number(name), argv };
  }
  return null;
}

// dataDirFromConfig reads olcDbDirectory out of the live cn=config backend
// instead of assuming /var/lib/ldap. Wiping a hardcoded path that is not
// actually the database would destroy the wrong thing and leave the real
// directory untouched, which is the worst of both outcomes.
async function dataDirFromConfig(configDir) {
  const dbDir = path.join(configDir, 'cn=config');
  let files = [];
  try {
    files = await io.readdir(dbDir);
  } catch (e) {
    throw new Error(`cannot read slapd config at ${dbDir}: ${e.message}`);
  }
  for (const f of files) {
    if (!/^olcDatabase=.*mdb\.ldif$/i.test(f)) continue;
    const text = await io.readFile(path.join(dbDir, f), 'utf8');
    const m = text.match(/^olcDbDirectory:\s*(.+)$/m);
    if (m) return m[1].trim();
  }
  throw new Error('could not determine olcDbDirectory from the slapd config');
}

async function stopSlapd(proc, { timeoutMs = 20000 } = {}) {
  try {
    io.kill(proc.pid, 'SIGTERM');
  } catch (e) {
    if (e.code === 'ESRCH') return; // already gone
    throw e;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      io.kill(proc.pid, 0);
    } catch (e) {
      if (e.code === 'ESRCH') return;
    }
    await io.sleep(200);
  }
  // A slapd that will not shut down cleanly must not be left half-running
  // alongside a slapadd writing the same database.
  try { io.kill(proc.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  await io.sleep(500);
}

// mdbFiles are the only things removed from the data directory. slapd.log and
// auditlog.ldif live there too and are not part of the database -- taking them
// out would throw away the record of what happened right when it is needed.
function isMdbFile(name) {
  return name === 'data.mdb' || name === 'lock.mdb';
}

// moveFile renames, falling back to copy+unlink when the two paths are on
// different filesystems.
//
// rename(2) cannot cross a mount boundary -- it returns EXDEV -- and every
// caller here is moving a file that may sit on a Docker volume. This is not
// theoretical: seeding failed on the first real spoke join with
//
//   EXDEV: cross-device link not permitted,
//   rename '/var/lib/ldap/data.mdb' -> '/tmp/ldap-preseed-<uuid>/data.mdb'
//
// because /var/lib/ldap is a volume and /tmp is the container's overlay. The
// stash now lives inside the data directory (see below) so the fallback should
// never fire, but a data directory assembled from several mounts is somebody
// else's legitimate choice and must not break the join.
async function moveFile(from, to) {
  try {
    await io.rename(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    await io.copyFile(from, to);
    await io.rm(from);
  }
}

// moveDatabaseAside stashes the existing database INSIDE the data directory.
//
// os.tmpdir() was the obvious choice and the wrong one: the data directory is
// a mount of its own in every deployment we ship, so the rename was guaranteed
// to fail with EXDEV before it had moved a single file. A stash that is a child
// of the directory being emptied is on that directory's filesystem by
// construction, whatever it is mounted from. The leading dot and the mdb-only
// filter keep it invisible to slapd, which opens data.mdb and lock.mdb by name
// and ignores everything else in olcDbDirectory.
async function moveDatabaseAside(dataDir) {
  const stash = path.join(dataDir, `.ldap-preseed-${crypto.randomUUID()}`);
  await io.mkdir(stash);
  const moved = [];
  const names = await io.readdir(dataDir);
  for (const name of names) {
    if (!isMdbFile(name)) continue;
    await moveFile(path.join(dataDir, name), path.join(stash, name));
    moved.push(name);
  }
  return { stash, moved };
}

async function restoreDatabase(dataDir, backup) {
  for (const name of backup.moved) {
    // Clear whatever slapadd managed to write before failing, or the rename
    // lands on top of a half-built database.
    await io.rm(path.join(dataDir, name)).catch(() => {});
    await moveFile(path.join(backup.stash, name), path.join(dataDir, name)).catch(() => {});
  }
}

async function startSlapd(argv) {
  const pid = io.spawnDetached(argv[0], argv.slice(1));
  return pid;
}

// waitForSlapd polls until the directory answers a base search. Restarting the
// process is not the same as the directory being usable, and returning early
// would hand the caller a window in which every LDAP call fails.
async function waitForSlapd(baseDn, { url = 'ldap://localhost:389', timeoutMs = 30000, bindDn, bindPassword } = {}) {
  const conf = require('@simpleworkjs/conf');
  const bDn = bindDn || (conf.ldap && conf.ldap.bindDN) || (conf.app_ldap && conf.app_ldap.bindDN) || (baseDn ? `cn=admin,${baseDn}` : '');
  const bPw = bindPassword || (conf.ldap && conf.ldap.bindPassword) || (conf.app_ldap && conf.app_ldap.bindPassword) || process.env.LDAP_ADMIN_PASS || '';
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const args = ['-x', '-H', url];
      if (bPw) {
        args.push('-D', bDn, '-w', bPw);
      }
      args.push('-b', baseDn, '-s', 'base', '(objectClass=*)');
      await io.execFile('ldapsearch', args, { timeout: 5000 });
      return true;
    } catch (e) {
      lastErr = e;
      await io.sleep(500);
    }
  }
  throw new Error(`slapd did not answer for ${baseDn} within ${timeoutMs}ms: ${lastErr && lastErr.message}`);
}

// seedFromMasterLdif replaces this node's directory with the master's dump.
//
// `ldif` MUST be raw slapcat output with its operational attributes intact --
// entryUUID and entryCSN above all. Passing it through stripOperationalAttrs
// (which the old ldapadd path had to, because slapd refuses them over LDAP)
// defeats the entire purpose: the entries would be assigned new identities and
// the spoke would once again look newer than the master.
async function seedFromMasterLdif(ldif, { baseDn, configDir = SLAPD_CONFIG_DIR } = {}) {
  if (!baseDn) throw new Error('seedFromMasterLdif: baseDn is required');
  if (!ldif || !String(ldif).trim()) throw new Error('seedFromMasterLdif: refusing to seed from an empty dump');
  if (!/^dn:\s*\S/m.test(ldif)) throw new Error('seedFromMasterLdif: dump contains no entries');
  // The whole point is that identity survives the copy. A dump without
  // entryUUID is not a replica seed, and using it would silently reintroduce
  // the bug this function exists to remove.
  if (!/^entryUUID:/mi.test(ldif)) {
    throw new Error('seedFromMasterLdif: dump has no entryUUID -- operational attributes were stripped, so this cannot seed a replica');
  }

  const proc = await findSlapdProcess();
  if (!proc) throw new Error('seedFromMasterLdif: could not find the running slapd to stop');

  const dataDir = await dataDirFromConfig(configDir);

  const ldifFile = path.join(os.tmpdir(), `ldap-seed-${crypto.randomUUID()}.ldif`);
  // 0600: a slapcat dump carries every password hash in the directory.
  await io.writeFile(ldifFile, ldif, { encoding: 'utf8', mode: 0o600 });

  let backup = null;
  try {
    await stopSlapd(proc);
    backup = await moveDatabaseAside(dataDir);

    // -q skips the consistency checks that only matter for hand-written LDIF;
    // this input came out of a live slapd's own slapcat.
    await io.execFile('slapadd', ['-q', '-F', configDir, '-b', baseDn, '-l', ldifFile], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300000
    });

    // slapadd runs as root here (the app is root in this image) but slapd runs
    // as the ldap user, and cannot open a database it does not own.
    await io.execFile('chown', ['-R', 'ldap:ldap', dataDir]).catch(() => {});

    await startSlapd(proc.argv);
    await waitForSlapd(baseDn);

    // Only now is the old database genuinely surplus.
    await io.rm(backup.stash).catch(() => {});
    return { seeded: true, dataDir, entries: countEntries(ldif) };
  } catch (e) {
    // Never leave the node without a directory. Put back what was there and
    // get slapd running again before reporting the failure.
    if (backup) {
      await restoreDatabase(dataDir, backup).catch(() => {});
      await io.rm(backup.stash).catch(() => {});
    }
    await startSlapd(proc.argv).catch(() => {});
    await waitForSlapd(baseDn).catch(() => {});
    throw new Error(`LDAP replica seeding failed and the previous directory was restored: ${e.message}`);
  } finally {
    await io.rm(ldifFile).catch(() => {});
  }
}

function countEntries(ldif) {
  return (String(ldif).match(/^dn:\s*\S/gm) || []).length;
}

module.exports = {
  seedFromMasterLdif,
  findSlapdProcess,
  dataDirFromConfig,
  stopSlapd,
  waitForSlapd,
  moveDatabaseAside,
  moveFile,
  restoreDatabase,
  countEntries,
  isMdbFile,
  SLAPD_CONFIG_DIR,
  __io: io
};
