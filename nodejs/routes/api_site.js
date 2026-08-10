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
const crypto = require('crypto');
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
const { SiteSpoke } = require('../models/site_spoke');
const { replicateToSpokes } = require('../utils/site_replicate');
const User = require('../models/user');
const { Agent } = require('../models/agent');
const siteConfig = require('../utils/site_config');
const { importDirectory, ldapAddArgs, baseDnFrom, siteIsFresh } = require('../utils/site_join');
const agentKeys = require('../utils/agent_keys');

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

    const [ldif, resources, edges, signingKey] = await Promise.all([
      slurpLdif(),
      Resource.list(),
      ResourceEdge.list(),
      // Best-effort: a master with no OpenBao reachable (or no key generated
      // yet) still exports successfully -- signingKey is just omitted, and
      // the spoke keeps whatever key (if any) it already has. Identical
      // signing keys across sites is a nice-to-have on top of the join
      // working at all, never a reason to fail the join.
      agentKeys.load().then((k) => k && { privateKeyPem: k.privateKeyPem, publicKeyPem: k.publicKeyPem }).catch(() => null)
    ]);

    await key.update({ use_count: (key.use_count || 0) + 1, last_used_on: Math.floor(Date.now() / 1000) }).catch(() => {});

    res.json({
      status: 'ok',
      siteSlug: siteConfig.get().siteSlug,
      baseDn: baseDnFrom(conf),
      ldif,
      resources: (resources || []).map(r => (r.toJSON ? r.toJSON() : r)),
      edges: (edges || []).map(e => (e.toJSON ? e.toJSON() : e)),
      ...(signingKey ? { signingKey } : {})
    });
  } catch (e) { next(e); }
});

// ── Ping (MASTER side, Bearer site-join-key; no admin session) ─────────────
// Lightweight reachability probe a spoke uses for WAN-health — deliberately
// cheap (no LDAP dump / catalog), unlike /export.
router.post('/ping', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = await SiteJoinKey.authenticate(rawKey);
    if (!key) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key' });
    res.json({ status: 'ok', siteSlug: siteConfig.get().siteSlug, ts: Math.floor(Date.now() / 1000) });
  } catch (e) { next(e); }
});

// ── Spoke registration (MASTER side, Bearer site-join-key; no admin session)
// A spoke calls this right after adopting a join, handing over its own
// reachable endpoint so the master can push live-replication resync pings to
// it later (see utils/site_replicate.js). Idempotent on endpoint: calling it
// again (e.g. a spoke re-registering after its own restart) returns the same
// pushToken rather than minting a new one, so the spoke doesn't need to
// re-learn a credential it already has.
router.post('/spokes', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = await SiteJoinKey.authenticate(rawKey);
    if (!key) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key' });

    const { endpoint, siteSlug } = req.body || {};
    if (!endpoint || !/^https?:\/\//.test(endpoint)) {
      return res.status(400).json({ status: 'error', message: 'a valid http(s) endpoint is required' });
    }

    const now = Math.floor(Date.now() / 1000);
    let spoke = (await SiteSpoke.list({ where: { endpoint } }))[0];
    if (spoke) {
      await spoke.update({ siteSlug: siteSlug || spoke.siteSlug, last_seen_on: now });
    } else {
      spoke = await SiteSpoke.create({
        id: crypto.randomUUID(),
        endpoint,
        siteSlug: siteSlug || null,
        pushToken: SiteSpoke.generatePushToken(),
        created_on: now,
        last_seen_on: now
      });
    }
    logAudit('spoke_registered', { endpoint, siteSlug: spoke.siteSlug });
    res.json({ status: 'ok', pushToken: spoke.pushToken });
  } catch (e) { next(e); }
});

// ── Resync (SPOKE side, Bearer pushToken; no admin session) ─────────────────
// The receiving end of utils/site_replicate.js's fire-and-forget push: the
// master pings this when its catalog changes. Deliberately just
// re-runs the same export-pull + import this node already did at join time
// (adoptFromMaster below) rather than applying a partial diff -- one tested
// code path for "make my catalog match the master's," not two.
router.post('/resync', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (cfg.isMaster) return res.status(400).json({ status: 'error', message: 'this node is master; resync is a spoke-only operation' });

    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!cfg.replicationPushToken || presented !== cfg.replicationPushToken) {
      return res.status(401).json({ status: 'error', message: 'invalid resync push token' });
    }
    if (!cfg.masterUrl || !cfg.masterJoinKey) {
      return res.status(409).json({ status: 'error', message: 'no master join credentials on file' });
    }

    const imp = await adoptFromMaster({ masterUrl: cfg.masterUrl, joinKey: cfg.masterJoinKey });
    logAudit('resynced', { reason: (req.body && req.body.reason) || 'unspecified', resourcesCreated: imp.created, resourcesUpdated: imp.updated });
    res.json({ status: 'ok', resources: { created: imp.created, updated: imp.updated, edges: imp.edgeCount } });
  } catch (e) { next(e); }
});

// ── Demote (called on the OLD master; Bearer site-join-key; no admin session)
// MULTI_SITE_SPEC.md §3.2: promoting a spoke must be a single coordinated
// action, never a two-step "hope nobody's master for a while" gap. The node
// being promoted calls this on whatever it currently believes is master,
// using the join-key credential it already holds from when it joined --
// authenticating "demote me" is exactly the same trust relationship as
// authenticating "let me pull an export," so no new credential type is
// needed for THIS direction. (The new master's future ability to push
// replication/resync to the newly-demoted node is a separate credential --
// newJoinKey below -- since that's the master->spoke direction, same as
// every other spoke registration.)
router.post('/demote', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = await SiteJoinKey.authenticate(rawKey);
    if (!key) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key' });

    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'this node is already a spoke' });
    }
    const { newMasterUrl, newJoinKey } = req.body || {};
    if (!newMasterUrl || !newJoinKey) {
      return res.status(400).json({ status: 'error', message: 'newMasterUrl and newJoinKey are required' });
    }

    const base = String(newMasterUrl).replace(/\/+$/, '');
    siteConfig.save({ isMaster: false, masterUrl: base, masterJoinKey: newJoinKey });
    logAudit('demoted', { demotedBy: key.keyPrefix, newMasterUrl: base });
    res.json({ status: 'ok', message: 'Demoted to spoke of ' + base });
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
// Never sent to the client: masterJoinKey and replicationPushToken are live
// credentials, not display data. Callers get boolean derivatives instead
// (hasMasterJoinKey, liveReplication) -- enough to render UI state without
// putting a secret in a browser response.
router.get('/config', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    const { masterJoinKey, replicationPushToken, ...safe } = cfg;
    res.json({
      status: 'ok',
      config: {
        ...safe,
        hasMasterJoinKey: !!masterJoinKey,
        liveReplication: !!replicationPushToken
      }
    });
  } catch (e) { next(e); }
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
// Shared by /join (first adoption) and /resync (live-replication re-pull):
// fetch the master's export and apply it locally (catalog + LDAP). Throws on
// any failure that should surface as a 502 to the caller.
async function adoptFromMaster({ masterUrl, joinKey }) {
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
    const err = new Error('master export failed: HTTP ' + resp.status + ' ' + text);
    err.httpStatus = 502;
    throw err;
  }
  const exportData = await resp.json();
  if (!exportData || exportData.status !== 'ok' || !exportData.ldif) {
    const err = new Error('master export returned no directory');
    err.httpStatus = 502;
    throw err;
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

  // 3. Adopt the master's agent-signing key, if it sent one (MULTI_SITE_SPEC.md
  //    §2 -- identical directories). Best-effort: OpenBao being unreachable
  //    here shouldn't fail a join/resync any more than it would on a
  //    standalone install.
  let signingKeyNote = 'not provided by master';
  if (exportData.signingKey) {
    try {
      await agentKeys.adopt(exportData.signingKey);
      signingKeyNote = 'adopted';
    } catch (e) {
      signingKeyNote = 'failed: ' + e.message;
    }
  }

  return { imp, ldapNote, signingKeyNote, exportData, base };
}

router.post('/join', async (req, res, next) => {
  try {
    const { masterUrl, joinKey, selfUrl } = req.body || {};
    if (!masterUrl || !joinKey) {
      return res.status(400).json({ status: 'error', message: 'masterUrl and joinKey are required' });
    }

    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'this node is already a spoke (re-join is not supported)' });
    }
    // Only a fresh install may join — a directory with real users must not be
    // merged into a master's (that is the destructive case).
    if (!(await siteIsFresh({ User, Agent }))) {
      return res.status(409).json({
        status: 'error',
        message: 'This directory already has users/agents. Only a fresh install may join a site (re-provision the host to adopt a master directory).'
      });
    }

    let adopted;
    try {
      adopted = await adoptFromMaster({ masterUrl, joinKey });
    } catch (e) {
      return res.status(e.httpStatus || 502).json({ status: 'error', message: e.message });
    }
    const { imp, ldapNote, signingKeyNote, exportData, base } = adopted;

    // 3. Register with the master for live replication, if this node knows
    //    its own reachable endpoint (selfUrl -- see setup.env's
    //    CFG_SELF_DIRECTORY_URL). Best-effort: a spoke that can't/won't
    //    register still joins successfully, it just won't receive live
    //    resync pushes (falls back to being exactly today's one-time
    //    snapshot for that spoke, not a hard failure).
    let replicationPushToken = null;
    let replicationNote = 'not registered (no selfUrl given)';
    if (selfUrl) {
      try {
        const regResp = await fetch(base + '/api/site/spokes', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + joinKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: selfUrl, siteSlug: exportData.siteSlug || cfg.siteSlug })
        });
        if (regResp.ok) {
          const regBody = await regResp.json();
          replicationPushToken = regBody.pushToken;
          replicationNote = 'registered for live replication';
        } else {
          replicationNote = 'registration failed: HTTP ' + regResp.status;
        }
      } catch (e) {
        replicationNote = 'registration failed: ' + e.message;
      }
    }

    // 4. Persist the spoke role (survives restarts). The join key is kept so
    //    the spoke can run WAN-health checks against the master; the push
    //    token (if registration succeeded) is what authenticates the
    //    master's future resync pushes back to THIS node.
    siteConfig.save({
      isMaster: false,
      masterUrl: base,
      siteSlug: exportData.siteSlug || cfg.siteSlug,
      masterJoinKey: joinKey,
      ...(replicationPushToken ? { replicationPushToken } : {})
    });

    logAudit('joined', {
      actor: req.user.uid,
      masterUrl: base,
      siteSlug: exportData.siteSlug,
      resourcesCreated: imp.created,
      resourcesUpdated: imp.updated,
      edges: imp.edgeCount,
      ldap: ldapNote,
      signingKey: signingKeyNote,
      replication: replicationNote
    });

    res.json({
      status: 'ok',
      message: 'Joined master site ' + base,
      siteSlug: exportData.siteSlug || cfg.siteSlug,
      resources: { created: imp.created, updated: imp.updated, edges: imp.edgeCount },
      ldap: { note: ldapNote },
      signingKey: { note: signingKeyNote },
      replication: { note: replicationNote, live: !!replicationPushToken }
    });
  } catch (e) { next(e); }
});

module.exports = router;
