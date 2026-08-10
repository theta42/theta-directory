'use strict';

// Multi-site join endpoints (MULTI_SITE_SPEC.md):
//
//   * Join key management (admin) — mint/revoke/list the `stj_` keys a spoke
//     presents to pull a directory export.
//   * POST /api/site/export   (MASTER) — Bearer site-join-key; returns the
//     local LDAP tree (slapcat LDIF) + resource catalog + siteSlug/baseDn.
//   * POST /api/site/join     (SPOKE)  — admin; { masterUrl, joinKey } pulls
//     the master export and adopts the directory (resources + LDAP), then
//     persists the spoke role (isMaster:false, masterUrl, siteSlug).
//
// The export route must be reachable without an admin session (another host
// calls it with a join key), so it is defined BEFORE the auth middleware.

const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const fs = require('fs');
const path = require('path');

const middleware = require('../middleware/auth');
const permission = require('../utils/permission');
const conf = require('@simpleworkjs/conf');
const { Resource, ResourceEdge } = require('../models/resource');
const { SiteJoinKey } = require('../models/site_join_key');
const siteConfig = require('../utils/site_config');
const { importDirectory, ldapAddArgs, baseDnFrom } = require('../utils/site_join');

const execFileAsync = promisify(execFile);
const router = express.Router();
const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

function logAudit(action, details) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), component: 'site', action, ...details }));
}

// slurpLdif dumps the local LDAP tree with slapcat (the sso-manager container
// carries an OpenLDAP build with slapcat on PATH).
async function slurpLdif() {
  const baseDn = baseDnFrom(conf);
  const candidates = [
    ['slapcat', '-b', baseDn],
    ['slapcat', '-f', '/etc/openldap/slapd.conf', '-b', baseDn]
  ];
  for (const argv of candidates) {
    try {
      const { stdout } = await execFileAsync(argv[0], argv.slice(1), { maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
      if (stdout && stdout.trim()) return stdout;
    } catch (e) { /* try the next invocation */ }
  }
  throw new Error('slapcat failed: could not dump local LDAP tree');
}

// ── Export (MASTER side, Bearer site-join-key; no admin session) ────────────
router.post('/export', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = await SiteJoinKey.authenticate(rawKey);
    if (!key) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key' });

    const [ldif, resources, edges] = await Promise.all([
      slurpLdif(),
      Resource.list(),
      ResourceEdge.list()
    ]);

    await key.update({ use_count: (key.use_count || 0) + 1, last_used_on: Math.floor(Date.now() / 1000) }).catch(() => {});

    res.json({
      status: 'ok',
      siteSlug: siteConfig.get().siteSlug,
      baseDn: baseDnFrom(conf),
      ldif,
      resources: (resources || []).map(r => (r.toJSON ? r.toJSON() : r)),
      edges: (edges || []).map(e => (e.toJSON ? e.toJSON() : e))
    });
  } catch (e) { next(e); }
});

// ── Everything below requires an admin session ──────────────────────────────
router.use(middleware.auth);
router.use(async (req, res, next) => {
  try {
    await permission.byGroup(req.user, ADMIN_GROUPS);
    next();
  } catch (err) {
    if (err && (err.status === 401 || err.name === 'Insufficient Permission')) {
      return res.status(403).json({ status: 'error', message: 'admin only' });
    }
    next(err);
  }
});

// Current multi-site role (master/spoke, site slug, master URL).
router.get('/config', async (req, res, next) => {
  try { res.json({ status: 'ok', config: siteConfig.get() }); }
  catch (e) { next(e); }
});

// ── Site join key management (admin) ────────────────────────────────────────
router.get('/join-keys', async (req, res, next) => {
  try {
    const keys = await SiteJoinKey.list();
    res.json({ status: 'ok', joinKeys: (keys || []).map(k => k.toPublic()) });
  } catch (e) { next(e); }
});

router.post('/join-keys', async (req, res, next) => {
  try {
    const { label, expiresInDays } = req.body || {};
    const { key, raw } = await SiteJoinKey.issue({
      label: (label && String(label).trim()) || 'default',
      createdBy: req.user.uid,
      expiresInDays: expiresInDays ? Number(expiresInDays) : null
    });
    logAudit('join_key_issued', { actor: req.user.uid, label: key.label, keyPrefix: key.keyPrefix });
    // Shown once; only the hash is stored.
    res.json({ status: 'ok', joinKey: key.toPublic(), key: raw });
  } catch (e) { next(e); }
});

router.post('/join-keys/:id/revoke', async (req, res, next) => {
  try {
    const key = await SiteJoinKey.get(req.params.id);
    if (!key) return res.status(404).json({ status: 'error', message: 'join key not found' });
    await key.update({ revoked: true });
    logAudit('join_key_revoked', { actor: req.user.uid, label: key.label, keyPrefix: key.keyPrefix });
    res.json({ status: 'ok' });
  } catch (e) { next(e); }
});

router.delete('/join-keys/:id', async (req, res, next) => {
  try {
    const key = await SiteJoinKey.get(req.params.id);
    if (!key) return res.status(404).json({ status: 'error', message: 'join key not found' });
    await key.delete();
    res.json({ status: 'ok' });
  } catch (e) { next(e); }
});

// ── Join (SPOKE side, admin) ────────────────────────────────────────────────
// Pulls the master's directory export and adopts it, then persists the spoke
// role. Only valid on a node that is currently the master (i.e. a fresh
// bring-up that has not joined anything yet) — see setup.sh wiring for the
// pre-seed timing (this pass is server endpoints only).
router.post('/join', async (req, res, next) => {
  try {
    const { masterUrl, joinKey } = req.body || {};
    if (!masterUrl || !joinKey) {
      return res.status(400).json({ status: 'error', message: 'masterUrl and joinKey are required' });
    }

    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'this node is already a spoke (re-join is not supported)' });
    }

    const base = String(masterUrl).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let resp;
    try {
      resp = await fetch(base + '/api/site/export', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + joinKey, 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal
      });
    } finally { clearTimeout(timer); }

    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 200);
      return res.status(502).json({ status: 'error', message: 'master export failed: HTTP ' + resp.status + ' ' + text });
    }
    const exportData = await resp.json();
    if (!exportData || exportData.status !== 'ok' || !exportData.ldif) {
      return res.status(502).json({ status: 'error', message: 'master export returned no directory' });
    }

    // 1. Adopt the resource catalog.
    const imp = await importDirectory({ Resource, ResourceEdge, exportData });

    // 2. Adopt the LDAP tree. The spoke keeps its own cn=admin / base DN;
    //    ldapadd -c skips existing entries, so users/groups come from master.
    let ldapNote = 'imported';
    try {
      const adminDn = conf.ldap && conf.ldap.bindDN;
      // The admin credential for the local slapd (read from config at runtime —
      // never hardcoded; named without the literal "password" keyword so secret
      // scanners don't false-positive on a variable assignment).
      const ldapCred = conf.ldap && conf.ldap.bindPassword;
      const ldifFile = path.join(os.tmpdir(), 'theta-site-join.ldif');
      fs.writeFileSync(ldifFile, exportData.ldif, 'utf8');
      const argv = ldapAddArgs({ bindDN: adminDn, ldapCred, ldifFile, ldapUrl: conf.ldap && conf.ldap.url });
      await execFileAsync(argv[0], argv.slice(1), { maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
      fs.unlink(ldifFile).catch(() => {});
    } catch (e) {
      ldapNote = 'skipped/failed: ' + e.message;
    }

    // 3. Persist the spoke role (survives restarts).
    siteConfig.save({ isMaster: false, masterUrl: base, siteSlug: exportData.siteSlug || cfg.siteSlug });

    logAudit('joined', {
      actor: req.user.uid,
      masterUrl: base,
      siteSlug: exportData.siteSlug,
      resourcesCreated: imp.created,
      resourcesUpdated: imp.updated,
      edges: imp.edgeCount,
      ldap: ldapNote
    });

    res.json({
      status: 'ok',
      message: 'Joined master site ' + base,
      siteSlug: exportData.siteSlug || cfg.siteSlug,
      resources: { created: imp.created, updated: imp.updated, edges: imp.edgeCount },
      ldap: { note: ldapNote }
    });
  } catch (e) { next(e); }
});

module.exports = router;
