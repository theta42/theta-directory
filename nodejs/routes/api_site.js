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
const { replicateToSpokes, pushResync } = require('../utils/site_replicate');
const { meshServiceTarget } = require('../utils/mesh_route');
const { withLock } = require('../utils/mutex');
// Applying LDAP replication config is a runtime operation now, not a
// setup.sh re-run: every event that changes who this node should replicate
// with converges slapd's live cn=config (utils/ldap_reconcile.js).
const { reconcileSoon } = require('../utils/ldap_reconcile');
const User = require('../models/user');
const { Agent } = require('../models/agent');
const siteConfig = require('../utils/site_config');
const {
  importDirectory, ldapAddArgs, baseDnFrom, siteIsFresh,
  stripOperationalAttrs, summarizeLdapAddResult
} = require('../utils/site_join');
const agentKeys = require('../utils/agent_keys');

const execFileAsync = promisify(execFile);
const router = express.Router();
const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

function logAudit(action, details) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), component: 'site', action, ...details }));
}

const { nextFreeLdapServerId, ldapHostFor } = require('../utils/ldap_replication');

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

    const { endpoint, siteSlug, noInbound, meshIp, publicHost } = req.body || {};
    if (!endpoint || !/^https?:\/\//.test(endpoint)) {
      return res.status(400).json({ status: 'error', message: 'a valid http(s) endpoint is required' });
    }

    const now = Math.floor(Date.now() / 1000);
    // Serialized: "pick the lowest free ServerID, then create the row" is a
    // read-then-write, and two spokes registering at the same moment both read
    // the same used-set and were both assigned the SAME id. That does not fail
    // loudly -- it quietly breaks MMR, since ServerID is how syncrepl tells
    // originators apart. (Seen for real: two concurrent registrations, both
    // ldapServerId 2.)
    const spoke = await withLock('site-spoke-register', async () => {
      let row = (await SiteSpoke.list({ where: { endpoint } }))[0];
      const patch = { siteSlug: siteSlug || (row && row.siteSlug) || null, last_seen_on: now, noInbound: !!noInbound, meshIp: meshIp || '', publicHost: publicHost || '' };
      if (row) {
        await row.update(patch);
        return row;
      }
      return SiteSpoke.create({
        id: crypto.randomUUID(),
        endpoint,
        pushToken: SiteSpoke.generatePushToken(),
        created_on: now,
        ldapServerId: await nextFreeLdapServerId(),
        ...patch
      });
    }, { label: `spoke registration: ${endpoint}` });

    // No-inbound relay automation: best-effort, never blocks registration.
    // See utils/proxy_client.js for why this reuses theta-proxy's existing
    // API token system rather than a new credential type.
    let relayNote = 'not applicable (spoke has inbound access)';
    if (noInbound) {
      if (meshIp && publicHost) {
        const proxyClient = require('../utils/proxy_client');
        // The relay points at the spoke's DIRECTORY over the routed mesh
        // (10.<siteId>.0.2), not at its gateway address -- the gateway is an
        // identifier for the site, not a service. theta-proxy needs a route
        // for 10.0.0.0/8 via the local gateway for this to carry traffic;
        // see docs/mesh.md.
        const target = meshServiceTarget(meshIp);
        if (target) {
          const result = await proxyClient.ensureRelayRoute({
            host: publicHost, ip: target.host, targetPort: target.port
          });
          relayNote = result.note;
        } else {
          relayNote = `skipped: ${meshIp} is not a mesh address`;
        }
      } else {
        relayNote = 'skipped: noInbound set but meshIp/publicHost missing';
      }
      await spoke.update({ relayNote });
    }

    // A new (or moved) spoke changes THIS node's peer list.
    reconcileSoon('spoke-registered');

    logAudit('spoke_registered', { endpoint, siteSlug: spoke.siteSlug, noInbound: !!noInbound, relayNote });
    res.json({ status: 'ok', pushToken: spoke.pushToken, relay: { note: relayNote } });
  } catch (e) { next(e); }
});

// ── LDAP replication peer list (SPOKE-callable, Bearer site join key) ───────
// OpenLDAP multi-master replication (docs/replication.md) needs each site to
// know its own ServerID plus every OTHER site's LDAPS URL. The master
// coordinates ID assignment (nextFreeLdapServerId, above); this is how a
// spoke asks "what's my ID, and who are my peers" -- called by
// theta-suite's bootstrap/site-ldap-register.js on every setup.sh run, not
// just once at join time, since the peer list changes as other spokes join.
// Same join-key auth as /spokes (a spoke already has this stored from its
// own join). `endpoint` identifies the CALLER so it can be excluded from its
// own peer list -- same identity SiteSpoke.list() keys registration on.
router.get('/ldap-peers', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = await SiteJoinKey.authenticate(rawKey);
    if (!key) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key' });

    const callerEndpoint = req.query.endpoint;
    if (!callerEndpoint) {
      return res.status(400).json({ status: 'error', message: 'endpoint query param is required' });
    }

    const cfg = siteConfig.get();
    const masterHost = ldapHostFor(cfg.masterUrl || req.protocol + '://' + req.get('host'));
    const spokes = await SiteSpoke.list();
    const caller = spokes.find((s) => s.endpoint === callerEndpoint);
    if (!caller || !caller.ldapServerId) {
      return res.status(404).json({ status: 'error', message: 'this endpoint is not a registered spoke -- register via POST /api/site/spokes first' });
    }

    const peers = [{ ldapServerId: 1, ldapHost: masterHost }];
    for (const s of spokes) {
      if (s.endpoint === callerEndpoint || !s.ldapServerId) continue;
      const host = ldapHostFor(s.endpoint);
      if (host) peers.push({ ldapServerId: s.ldapServerId, ldapHost: host });
    }

    res.json({ status: 'ok', ldapServerId: caller.ldapServerId, peers });
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
    // The catalog isn't the only thing that can have moved on: a resync is
    // also the signal that the cluster changed, so re-ask the master what
    // this node's replication config should be.
    reconcileSoon('resync');

    logAudit('resynced', { reason: (req.body && req.body.reason) || 'unspecified', resourcesCreated: imp.created, resourcesUpdated: imp.updated });
    res.json({ status: 'ok', resources: { created: imp.created, updated: imp.updated, edges: imp.edgeCount } });
  } catch (e) { next(e); }
});

// ── Master changed (SPOKE side, Bearer pushToken; no admin session) ─────────
// The other half of promotion in a cluster with more than two sites. The
// newly-promoted master inherits the old master's spoke registry (see
// /demote below) and calls this on each of those spokes to re-point them.
//
// Authenticated with the SAME replicationPushToken this node already accepts
// on /resync -- i.e. the credential that already means "you are my master,
// act on it". Nothing new is trusted here: a caller holding this token can
// already make this node re-pull and adopt a full directory export, so it can
// already dictate this node's catalog. Being told where to pull it FROM is
// strictly less authority than that.
//
// selfEndpoint comes from the caller because the new master knows this node's
// registered endpoint (it inherited the row) and this node may not: a spoke
// that joined before selfUrl was persisted has no record of its own reachable
// address. It falls back to the locally-known one when the caller omits it.
router.post('/master-changed', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'this node is master; it cannot be re-pointed at another master' });
    }

    const auth = req.headers.authorization || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!cfg.replicationPushToken || presented !== cfg.replicationPushToken) {
      return res.status(401).json({ status: 'error', message: 'invalid resync push token' });
    }

    const { newMasterUrl, newJoinKey, selfEndpoint } = req.body || {};
    if (!newMasterUrl || !newJoinKey) {
      return res.status(400).json({ status: 'error', message: 'newMasterUrl and newJoinKey are required' });
    }
    const base = String(newMasterUrl).replace(/\/+$/, '');
    const selfUrl = selfEndpoint || cfg.selfUrl || '';

    siteConfig.save({ masterUrl: base, masterJoinKey: newJoinKey, ...(selfUrl ? { selfUrl } : {}) });

    // Re-register with the new master so it has a live row for this node
    // (ldapServerId, relay state) and so this node picks up whatever
    // pushToken the new master intends to use going forward. Best-effort for
    // the same reason join's registration is: a spoke that can't register is
    // still correctly re-pointed and will resync on the next push it accepts.
    let registrationNote = 'not attempted (this node does not know its own endpoint)';
    let adopted = null;
    if (selfUrl) {
      try {
        const regResp = await fetch(base + '/api/site/spokes', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + newJoinKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: selfUrl, siteSlug: cfg.siteSlug })
        });
        if (regResp.ok) {
          const regBody = await regResp.json();
          if (regBody.pushToken) siteConfig.save({ replicationPushToken: regBody.pushToken });
          registrationNote = 'registered with the new master';
        } else {
          registrationNote = 'registration failed: HTTP ' + regResp.status;
        }
      } catch (e) {
        registrationNote = 'registration failed: ' + e.message;
      }
    }

    // Pull the new master's catalog immediately rather than waiting for its
    // next write: a promotion is exactly when the catalog is most likely to
    // have moved on without this node.
    let resyncNote = 'not attempted';
    try {
      const imp = await adoptFromMaster({ masterUrl: base, joinKey: newJoinKey });
      adopted = { created: imp.imp.created, updated: imp.imp.updated, edges: imp.imp.edgeCount };
      resyncNote = 'resynced from the new master';
    } catch (e) {
      resyncNote = 'resync failed: ' + e.message;
    }

    reconcileSoon('master-changed');

    logAudit('master_changed', { newMasterUrl: base, registrationNote, resyncNote });
    res.json({ status: 'ok', message: 'Now following ' + base, registration: { note: registrationNote }, resync: { note: resyncNote }, resources: adopted });
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

    // Register with the new master immediately, the same way a real /join
    // does (POST /spokes) -- without this, a demoted former master was
    // orphaned: it had a masterJoinKey but no SiteSpoke entry on the new
    // master (so no ldapServerId, no live replication push target), and
    // structurally could never self-heal via /join (which refuses re-join
    // for a node that's already a spoke, and requires a fresh install --
    // neither true for a former master with real users/agents). Best-effort:
    // failing to register here must not fail the demotion itself, same
    // reasoning as a normal join's optional live-replication registration.
    let registrationNote = 'not attempted (no stack.ssoHost/stack.selfUrl configured to register with)';
    // stack.selfUrl is a full-URL override (scheme + port) for environments
    // where "https://<ssoHost>" isn't the real reachable address -- the
    // multisite e2e test harness (plain HTTP, docker-network hostnames,
    // no TLS/proxy in front) is exactly that case; every real deployment
    // just relies on the ssoHost derivation.
    const selfUrl = (conf.stack && conf.stack.selfUrl) || (conf.stack && conf.stack.ssoHost && `https://${conf.stack.ssoHost}`);
    if (selfUrl) {
      try {
        const regResp = await fetch(base + '/api/site/spokes', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + newJoinKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: selfUrl, siteSlug: cfg.siteSlug })
        });
        if (regResp.ok) {
          const regBody = await regResp.json();
          if (regBody.pushToken) siteConfig.save({ replicationPushToken: regBody.pushToken });
          registrationNote = 'registered as a spoke of the new master';
        } else {
          registrationNote = 'registration failed: HTTP ' + regResp.status;
        }
      } catch (e) {
        registrationNote = 'registration failed: ' + e.message;
      }
    }
    logAudit('demoted_self_registered', { newMasterUrl: base, registrationNote });

    // Hand the outgoing master's spoke registry to the incoming one.
    //
    // Without this, promotion only ever worked for a TWO-site cluster: the
    // promoted node was itself a spoke, so its own SiteSpoke table is empty,
    // and site-promote's replicateToSpokes('master-promoted') fanned out to
    // nobody. Every OTHER spoke (C, D, ...) kept masterUrl pointed at this
    // now-demoted node and silently stopped receiving updates, while the new
    // master had no idea they existed.
    //
    // The pushTokens ride along deliberately. They are the master->spoke
    // credential (see models/site_spoke.js), and this response is already
    // gated on a valid site join key -- the same credential that authorizes
    // "stop being master at all". A caller who can demote us can already pull
    // a full directory export; withholding the tokens here would buy no
    // security, and would instead force every spoke to accept a re-point from
    // an unknown node, which is a genuinely weaker trust rule.
    let handoverSpokes = [];
    try {
      const spokes = await SiteSpoke.list();
      handoverSpokes = (spokes || [])
        // The new master is (or was) in this list too; it doesn't need to be
        // handed a registration for itself.
        .filter((s) => s.endpoint && s.endpoint.replace(/\/+$/, '') !== base)
        .map((s) => ({
          endpoint: s.endpoint, siteSlug: s.siteSlug, pushToken: s.pushToken,
          ldapServerId: s.ldapServerId || null, noInbound: !!s.noInbound,
          meshIp: s.meshIp || '', publicHost: s.publicHost || ''
        }));
    } catch (e) {
      console.error('[site] could not read the local spoke registry for handover:', e.message);
    }

    res.json({
      status: 'ok',
      message: 'Demoted to spoke of ' + base,
      registration: { note: registrationNote },
      spokes: handoverSpokes
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

// ── Registered-spoke management (MASTER side, admin) ────────────────────────
// The Registered Spokes table was read-only, which left an operator with no
// way to clear a decommissioned site (its row keeps holding an LDAP ServerID
// and keeps receiving replication pushes forever) or to force a sync without
// making an unrelated catalog write just to trigger the fire-and-forget push.
router.get('/spokes', async (req, res, next) => {
  try {
    const spokes = await SiteSpoke.list();
    res.json({ status: 'ok', spokes: (spokes || []).map(s => s.toPublic()) });
  } catch (e) { next(e); }
});

router.delete('/spokes/:id', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'only the master holds a spoke registry' });
    }
    const spoke = (await SiteSpoke.list({ where: { id: req.params.id } }))[0];
    if (!spoke) return res.status(404).json({ status: 'error', message: 'spoke not found' });

    const { endpoint, siteSlug, ldapServerId } = spoke;
    await spoke.delete();
    // Its syncrepl entry has to come out of the running config too.
    reconcileSoon('spoke-removed');

    logAudit('spoke_removed', { actor: req.user.uid, endpoint, siteSlug, ldapServerId });
    // Deliberately does NOT tell the spoke anything: this is for a site that
    // is gone or being decommissioned, which by definition may be
    // unreachable. It stops replication pushes and frees the ServerID here.
    // The removed site keeps its own local copy and stays read-only until an
    // operator re-provisions it.
    res.json({
      status: 'ok',
      message: `Removed ${siteSlug || endpoint} from the spoke registry`,
      note: ldapServerId
        ? `LDAP ServerID ${ldapServerId} is now free for reuse; this peer's syncrepl entry is being dropped from the running slapd.`
        : null
    });
  } catch (e) { next(e); }
});

// Force a resync push at one spoke (or all of them) right now.
router.post('/spokes/resync', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'only the master pushes resyncs' });
    }
    const { id } = req.body || {};
    const spokes = await SiteSpoke.list();
    const targets = id ? (spokes || []).filter(s => s.id === id) : (spokes || []);
    if (targets.length === 0) {
      return res.status(404).json({ status: 'error', message: id ? 'spoke not found' : 'no spokes registered' });
    }

    // Unlike the write-triggered path this one AWAITS the result: an operator
    // clicking "Sync now" is asking a question ("can you reach it?"), and a
    // fire-and-forget answer of "sure, probably" would be useless to them.
    const results = await Promise.all(targets.map(async (spoke) => {
      try {
        await pushResync(spoke, 'manual');
        await spoke.update({ last_seen_on: Math.floor(Date.now() / 1000) }).catch(() => {});
        return { endpoint: spoke.endpoint, ok: true };
      } catch (e) {
        return { endpoint: spoke.endpoint, ok: false, error: e.message };
      }
    }));

    logAudit('spokes_resynced', { actor: req.user.uid, requested: targets.length, ok: results.filter(r => r.ok).length });
    res.json({ status: 'ok', results, ok: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
  } catch (e) { next(e); }
});

// ── Re-register (SPOKE side, admin) ─────────────────────────────────────────
// Re-runs just the registration half of a join, using the master credentials
// this node already holds. Needed because registration only ever happened at
// join time, so a spoke had no way back from any state where the master's
// SiteSpoke row and this node's pushToken disagree:
//
//   * an operator removed this spoke from the registry (a real action now —
//     see DELETE /spokes/:id) and wants it back,
//   * the master's row was recreated, so it holds a token this node doesn't,
//   * the original join ran without selfUrl, leaving this node stuck on a
//     one-time snapshot with no live replication.
//
// /join can't do any of these: it refuses once this node is a spoke, and it
// requires a fresh install. This is deliberately just the registration, never
// a directory adoption.
router.post('/reregister', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'this node is the master; it has no master to register with' });
    }
    if (!cfg.masterUrl || !cfg.masterJoinKey) {
      return res.status(409).json({ status: 'error', message: 'no master credentials on file -- this node has not joined a site' });
    }
    const selfUrl = (req.body && req.body.selfUrl) || cfg.selfUrl;
    if (!selfUrl) {
      return res.status(400).json({ status: 'error', message: 'this node does not know its own reachable URL; pass selfUrl' });
    }

    const base = String(cfg.masterUrl).replace(/\/+$/, '');
    const resp = await fetch(base + '/api/site/spokes', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.masterJoinKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: selfUrl,
        siteSlug: cfg.siteSlug,
        ...(cfg.noInbound ? { noInbound: true, meshIp: cfg.meshIp, publicHost: cfg.publicHost } : {})
      })
    });
    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 200);
      return res.status(502).json({ status: 'error', message: `master rejected the registration: HTTP ${resp.status} ${text}` });
    }
    const body = await resp.json();
    siteConfig.save({ selfUrl, ...(body.pushToken ? { replicationPushToken: body.pushToken } : {}) });

    reconcileSoon('reregistered');

    logAudit('reregistered', { actor: req.user.uid, masterUrl: base, selfUrl });
    res.json({
      status: 'ok',
      message: 'Re-registered with ' + base,
      live: !!body.pushToken,
      relay: body.relay || null
    });
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

  // MULTI_SITE_SPEC.md §4: CFG_DOMAIN — and therefore the LDAP base DN — must
  // be identical at every site; MMR replicas cannot diverge on it. When they
  // differ, the LDIF below fails on every single entry with "no global
  // superior knowledge" and the join otherwise LOOKS successful: the catalog
  // and signing key are adopted, and the LDAP failure is buried in a note. So
  // refuse up front, with the two DNs in the message, instead of half-joining.
  const localBaseDn = baseDnFrom(conf);
  if (exportData.baseDn && localBaseDn && exportData.baseDn !== localBaseDn) {
    const err = new Error(
      `base DN mismatch: this site is ${localBaseDn}, the master is ${exportData.baseDn}. ` +
      'Every site in a cluster must share one CFG_DOMAIN (see MULTI_SITE_SPEC.md §4) — ' +
      're-provision this site with the master\'s domain before joining.'
    );
    err.httpStatus = 409;
    throw err;
  }

  // 1. Adopt the resource catalog.
  const imp = await importDirectory({ Resource, ResourceEdge, exportData });

  // 2. Adopt the LDAP tree. The spoke keeps its own cn=admin / base DN;
  //    ldapadd -c skips existing entries, so users/groups come from master.
  let ldapNote = 'imported';
  // Unique per call and 0600: this file is a full slapcat dump (password
  // hashes included), and a fixed name meant two concurrent joins/resyncs
  // would overwrite each other's dump mid-ldapadd.
  const ldifFile = path.join(os.tmpdir(), `theta-site-join-${crypto.randomUUID()}.ldif`);
  try {
    const adminDn = conf.ldap && conf.ldap.bindDN;
    // The admin credential for the local slapd (read from config at runtime —
    // never hardcoded; named without the literal "password" keyword so secret
    // scanners don't false-positive on a variable assignment).
    const ldapCred = conf.ldap && conf.ldap.bindPassword;
    // slapcat's operational attributes have to come out before ldapadd will
    // take any of this (see stripOperationalAttrs).
    fs.writeFileSync(ldifFile, stripOperationalAttrs(exportData.ldif), { encoding: 'utf8', mode: 0o600 });
    const argv = ldapAddArgs({ bindDN: adminDn, ldapCred, ldifFile, ldapUrl: conf.ldap && conf.ldap.url });
    await execFileAsync(argv[0], argv.slice(1), { maxBuffer: 4 * 1024 * 1024, timeout: 120000 });
  } catch (e) {
    // `ldapadd -c` exits non-zero even when the only failures were entries
    // this spoke already had, which is every join. Classify before reporting.
    const summary = summarizeLdapAddResult(e.stderr);
    ldapNote = summary.note || ('skipped/failed: ' + e.message);
  } finally {
    // fs.promises, not the callback-style fs.unlink this used to call: the
    // latter throws ERR_INVALID_ARG_TYPE synchronously when handed no
    // callback, which the catch above then reported as "LDAP import
    // skipped/failed" on EVERY join and resync -- even though ldapadd had
    // already succeeded a line earlier. In a finally so a FAILED ldapadd
    // doesn't leave the dump on disk either.
    await fs.promises.unlink(ldifFile).catch(() => {});
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
    const { masterUrl, joinKey, selfUrl, noInbound, meshIp, publicHost } = req.body || {};
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
    let relayNote = noInbound ? 'not attempted (registration did not run)' : 'not applicable (this spoke has inbound access)';
    if (selfUrl) {
      try {
        const regResp = await fetch(base + '/api/site/spokes', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + joinKey, 'Content-Type': 'application/json' },
          // noInbound/meshIp/publicHost: this spoke has no public IP of its
          // own; forwarded so the master can best-effort auto-create a relay
          // route on its own theta-proxy (utils/proxy_client.js). Previously
          // accepted by /spokes but never actually reachable from here --
          // nothing forwarded them, so the automation existed but no real
          // join flow could ever trigger it.
          body: JSON.stringify({
            endpoint: selfUrl,
            siteSlug: exportData.siteSlug || cfg.siteSlug,
            ...(noInbound ? { noInbound: true, meshIp, publicHost } : {})
          })
        });
        if (regResp.ok) {
          const regBody = await regResp.json();
          replicationPushToken = regBody.pushToken;
          replicationNote = 'registered for live replication';
          if (regBody.relay) relayNote = regBody.relay.note;
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
      // Remembered so this node can re-register itself later without being
      // told its own address again -- notably when a promotion elsewhere
      // re-points it at a new master (POST /master-changed).
      ...(selfUrl ? { selfUrl } : {}),
      ...(replicationPushToken ? { replicationPushToken } : {})
    });

    // Now that this node knows its master and its own endpoint, pull the
    // replication config it was just assigned and apply it live.
    reconcileSoon('joined');

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
      replication: { note: replicationNote, live: !!replicationPushToken },
      relay: { note: relayNote }
    });
  } catch (e) { next(e); }
});

module.exports = router;
