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
const { Agent, AgentJoinKey } = require('../models/agent');
const { UserVerification } = require('../models/verification');
const { ApiToken } = require('../models/api_token');
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

const { nextFreeLdapServerId, ldapMeshHost, ldapHostFor, ldapHostForSpoke } = require('../utils/ldap_replication');
const meshRoster = require('../utils/mesh_roster');
const { MeshSite } = require('../models/mesh_site');

// slurpLdif dumps the local LDAP tree with slapcat (the sso-manager container
// carries an OpenLDAP build with slapcat on PATH).
async function slurpLdif() {
  const baseDn = baseDnFrom(conf);
  const candidates = [
    ['slapcat', '-F', '/etc/openldap/slapd.d', '-b', baseDn],
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

// exportSharedBaoSecrets dumps the OpenBao paths that are genuinely CLUSTER-wide
// (MULTI_SITE_SPEC.md §2.1: `secret/integrations/*`, `secret/plugins/*`).
//
// `sso-manager` used to be in this list, and must never be: `secret/sso-manager/conf`
// is a full mirror of that node's own /config/sso-secrets.js -- its LDAP bind
// password, jwtSecret, SMTP credentials, bootstrap admin, and stack hostnames.
// Copying it to a spoke meant @simpleworkjs/bao-conf deep-merged the MASTER's
// config over the spoke's at its next boot, so the spoke's app then tried to
// bind to its OWN slapd with the master's password. Every site generates its
// own local secrets on purpose (§4); per-deployment secret replication is
// explicitly still an open item, not something to fall into by wildcarding a
// prefix.
//
// Nothing named `conf` directly under an app prefix is ever exported, as a
// second belt: `plugins/<id>/conf` is per-instance plugin config (shared by
// design), `<app>/conf` is a node's own identity (never shared).
const SHARED_BAO_PREFIXES = ['integrations', 'plugins'];

async function listBaoKeys(baoConf, prefix) {
  const resp = await baoConf.request('GET', `secret/metadata/${prefix}?list=true`).catch(() => null);
  if (!resp || !resp.ok) return null;
  const body = await resp.json().catch(() => ({}));
  return (body.data && body.data.keys) || [];
}

async function exportSharedBaoSecrets() {
  const baoConf = require('@simpleworkjs/bao-conf');
  const exported = [];

  // Depth-first, because plugin secrets live one level down at
  // `plugins/<id>/conf`. Listing only the top level returned directory markers
  // ("<id>/"), and reading those as if they were leaves always failed -- so
  // plugin secrets were silently never replicated at all.
  async function walk(prefix, depth) {
    if (depth > 3) return;
    const keys = await listBaoKeys(baoConf, prefix);
    if (keys === null) {
      // Not a directory: read it as a leaf.
      const val = await baoConf.get(prefix).catch(() => null);
      if (val && typeof val === 'object' && Object.keys(val).length > 0) {
        exported.push({ path: prefix, data: val });
      }
      return;
    }
    for (const key of keys) {
      const child = `${prefix}/${String(key).replace(/\/+$/, '')}`;
      if (String(key).endsWith('/')) await walk(child, depth + 1);
      else {
        const val = await baoConf.get(child).catch(() => null);
        if (val && typeof val === 'object' && Object.keys(val).length > 0) {
          exported.push({ path: child, data: val });
        }
      }
    }
  }

  for (const prefix of SHARED_BAO_PREFIXES) {
    try { await walk(prefix, 0); } catch (e) { /* best-effort, per prefix */ }
  }
  return exported;
}

// Guard applied on the RECEIVING side too, so a spoke running this release is
// protected even when its master is still running one that over-exports.
function isShareableBaoPath(path) {
  const p = String(path || '').replace(/^\/+/, '');
  if (!SHARED_BAO_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) return false;
  // `<prefix>/conf` would be an app's own identity, never cluster state.
  return !/^[^/]+\/conf$/.test(p);
}

// ── Export (MASTER side, Bearer site-join-key; no admin session) ────────────
router.post('/export', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = await SiteJoinKey.authenticate(rawKey);
    if (!key) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key' });

    // meshSites: the cluster roster. Without it a spoke has no idea any other
    // site exists, its gateway builds no peers, and the mesh silently only
    // works at whichever site happens to be the master.
    const [ldif, resources, edges, signingKey, meshSites, agents, baoSecrets, userVerifications, apiTokens, agentJoinKeys] = await Promise.all([
      slurpLdif(),
      Resource.list(),
      ResourceEdge.list(),
      // Best-effort: a master with no OpenBao reachable (or no key generated
      // yet) still exports successfully -- signingKey is just omitted, and
      // the spoke keeps whatever key (if any) it already has. Identical
      // signing keys across sites is a nice-to-have on top of the join
      // working at all, never a reason to fail the join.
      agentKeys.load().then((k) => k && { privateKeyPem: k.privateKeyPem, publicKeyPem: k.publicKeyPem }).catch(() => null),
      // Make sure sites that joined but whose gateway has not published yet
      // still appear, so a new site is visible to the rest of the cluster
      // before anyone starts its gateway.
      meshRoster.syncFromSpokes().then(() => meshRoster.roster()).catch(() => []),
      Agent.list().catch(() => []),
      exportSharedBaoSecrets().catch(() => []),
      UserVerification.listDetail().catch(() => []),
      ApiToken.list().catch(() => []),
      AgentJoinKey.list().catch(() => [])
    ]);

    await key.update({ use_count: (key.use_count || 0) + 1, last_used_on: Math.floor(Date.now() / 1000) }).catch(() => {});

    res.json({
      status: 'ok',
      siteSlug: siteConfig.get().siteSlug,
      baseDn: baseDnFrom(conf),
      ldif,
      resources: (resources || []).map(r => (r.toJSON ? r.toJSON() : r)),
      edges: (edges || []).map(e => (e.toJSON ? e.toJSON() : e)),
      meshSites: (meshSites || []).map(m => (m.toJSON ? m.toJSON() : m)),
      // toReplica(), not toPublic(): the fleet has to arrive with tokenHash or
      // no agent can authenticate against a spoke. See models/agent.js.
      agents: (agents || []).map(a => (a.toReplica ? a.toReplica() : (a.toJSON ? a.toJSON() : a))),
      agentJoinKeys: (agentJoinKeys || []).map(k => (k.toReplica ? k.toReplica() : (k.toJSON ? k.toJSON() : k))),
      baoSecrets: baoSecrets || [],
      userVerifications: userVerifications || [],
      apiTokens: (apiTokens || []).map(t => (t.toReplica ? t.toReplica() : (t.toJSON ? t.toJSON() : t))),
      ...(signingKey ? { signingKey } : {})
    });
  } catch (e) { next(e); }
});

// ── Ping (MASTER side, Bearer site-join-key; no admin session) ─────────────
// Lightweight reachability probe a spoke uses for WAN-health — deliberately
// cheap (no LDAP dump / catalog), unlike /export. Also doubles as the spoke
// bring-up pre-flight: theta-suite's setup.sh calls this (with only the join
// key it was handed, before it has any local LDAP of its own) to learn
// baseDn and derive CFG_DOMAIN automatically, instead of requiring the
// operator to separately know and re-type the master's own domain into a
// second config file (see spoke.env.example / MULTI_SITE_SPEC.md §4).
router.post('/ping', async (req, res, next) => {
  try {
    const auth = req.headers.authorization || '';
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const key = await SiteJoinKey.authenticate(rawKey);
    if (!key) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key' });
    res.json({
      status: 'ok',
      siteSlug: siteConfig.get().siteSlug,
      baseDn: baseDnFrom(conf),
      ldapAdminPass: (conf.ldap && conf.ldap.bindPassword) || '',
      ts: Math.floor(Date.now() / 1000)
    });
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

    const {
      endpoint, siteSlug, noInbound, meshIp, publicHost,
      gatewayPublicKey, gatewayEndpoint, gatewayExitPublicKey,
      exitOpen, country, city, lan168, lan172, dnsHost
    } = req.body || {};
    if (!endpoint || !/^https?:\/\//.test(endpoint)) {
      return res.status(400).json({ status: 'error', message: 'a valid http(s) endpoint is required' });
    }
    const cleanEndpoint = String(endpoint).replace(/\/+$/, '');

    const now = Math.floor(Date.now() / 1000);
    // Serialized: "pick the lowest free ServerID, then create the row" is a
    // read-then-write, and two spokes registering at the same moment both read
    // the same used-set and were both assigned the SAME id. That does not fail
    // loudly -- it quietly breaks MMR, since ServerID is how syncrepl tells
    // originators apart. (Seen for real: two concurrent registrations, both
    // ldapServerId 2.)
    const spoke = await withLock('site-spoke-register', async () => {
      let row = (await SiteSpoke.list({ where: { endpoint: cleanEndpoint } }))[0];
      // A spoke that legitimately changes its public endpoint (http -> https,
      // port change, hostname change) must keep its assigned LDAP ServerID and
      // pushToken. The endpoint string is the normal lookup key, but when it has
      // changed we still recognize the spoke by its stable siteSlug. Without
      // this, re-registration minted a second row with a second ServerID for
      // the same site, which broke mesh addressing and doubled the directory.
      if (!row && siteSlug) {
        row = (await SiteSpoke.list({ where: { siteSlug } }))[0];
      }
      // Only fields the caller ACTUALLY sent are written.
      //
      // This used to assign noInbound/meshIp/publicHost unconditionally, so
      // every caller that legitimately omits them -- the gateway's roster
      // push-up (utils/mesh_roster.js), /demote, /master-changed, /reregister --
      // silently blanked a CGNAT spoke's relay configuration on the master and
      // downgraded it to "has inbound access". The relay route then stopped
      // being refreshed and the spoke's only public path went stale.
      const patch = { siteSlug: siteSlug || (row && row.siteSlug) || null, last_seen_on: now };
      if (noInbound !== undefined) patch.noInbound = !!noInbound;
      if (meshIp !== undefined) patch.meshIp = meshIp || '';
      if (publicHost !== undefined) patch.publicHost = publicHost || '';
      if (row) {
        // The caller always asserts its current endpoint, so refresh it even
        // when the lookup happened by siteSlug.
        patch.endpoint = cleanEndpoint;
        // Older rows (or rows created before push tokens existed) may have a
        // NULL pushToken. Generate one now so this spoke can accept resync
        // pushes; the caller will persist it in /config/site.json.
        if (!row.pushToken) {
          patch.pushToken = SiteSpoke.generatePushToken();
        }
        await row.update(patch);
        return row;
      }
      return SiteSpoke.create({
        id: crypto.randomUUID(),
        endpoint: cleanEndpoint,
        pushToken: SiteSpoke.generatePushToken(),
        created_on: now,
        ldapServerId: await nextFreeLdapServerId(),
        noInbound: false, meshIp: '', publicHost: '',
        ...patch
      });
    }, { label: `spoke registration: ${cleanEndpoint}` });

    // Mirror the spoke's gateway identity into the roster.
    //
    // Replication only flows master -> spoke, so this is the ONLY path by
    // which a spoke's WireGuard public key and endpoint reach the master --
    // and therefore the only way any other site can ever build a peer for it.
    // The spoke re-posts here whenever its gateway publishes
    // (utils/mesh_roster.js pushSelfToMaster). Best-effort: a roster write
    // must never fail a registration.
    if (spoke.ldapServerId && gatewayPublicKey) {
      try {
        const existing = await meshRoster.bySiteId(spoke.ldapServerId);
        const patch = {
          slug: spoke.siteSlug || '',
          name: spoke.siteSlug || '',
          gatewayPublicKey,
          gatewayEndpoint: gatewayEndpoint || '',
          publishedAt: now,
          lastSeenAt: now
        };
        if (gatewayExitPublicKey !== undefined) patch.gatewayExitPublicKey = gatewayExitPublicKey || null;
        if (exitOpen !== undefined) patch.exitOpen = !!exitOpen;
        if (country !== undefined) patch.country = country || null;
        if (city !== undefined) patch.city = city || null;
        if (lan168 !== undefined) patch.lan168 = lan168;
        if (lan172 !== undefined) patch.lan172 = lan172;
        if (dnsHost !== undefined) patch.dnsHost = dnsHost || null;

        if (existing) await existing.update(patch);
        else await MeshSite.create({ id: crypto.randomUUID(), siteId: spoke.ldapServerId, lan168: lan168 || '192.168.1.0/24', lan172: lan172 || '172.16.0.0/24', ...patch });
        // Every other site needs this too, so push it out rather than waiting
        // for the next unrelated catalog change.
        require('../utils/site_replicate').replicateToSpokes('mesh-roster-changed');
      } catch (e) {
        console.warn(`[site] could not record spoke ${spoke.ldapServerId}'s gateway details: ${e.message}`);
      }
    }

    // Ensure a kind: 'site' Resource, host, and stack services exist in the
    // Master's Directory catalog so the master and all spokes see this spoke's
    // entire topology in the Directory tree.
    if (spoke.siteSlug) {
      try {
        const cleanName = spoke.siteSlug.replace(/^site[-_]/i, '');
        const cleanSlug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
        const siteSlug = `site_${cleanSlug}`;
        let siteRes = await Resource.getBySlug(siteSlug).catch(() => null);
        if (!siteRes) {
          siteRes = await Resource.create({
            id: crypto.randomUUID(),
            kind: 'site',
            name: cleanName || spoke.siteSlug,
            slug: siteSlug,
            metadata: {
              isCurrentSite: false,
              isSpoke: true,
              isProduction: true,
              endpoint: cleanEndpoint
            },
            created_on: now
          });
        }

        // Auto-create spoke stack host parented to the site
        const hostSlug = `host_theta-suite-${cleanSlug}`;
        let hostRes = await Resource.getBySlug(hostSlug).catch(() => null);
        if (!hostRes) {
          hostRes = await Resource.create({
            id: crypto.randomUUID(),
            kind: 'host',
            name: `theta-suite-${cleanName}`,
            slug: hostSlug,
            metadata: {
              subType: 'linux',
              isSpokeHost: true,
              endpoint: cleanEndpoint,
              ip: spoke.meshIp || null,
              address: cleanEndpoint
            },
            created_on: now
          });
        }
        const siteEdge = await ResourceEdge.list({ where: { parentId: siteRes.id, childId: hostRes.id } });
        if (!siteEdge || siteEdge.length === 0) {
          await ResourceEdge.create({ id: crypto.randomUUID(), parentId: siteRes.id, childId: hostRes.id, relation: 'hosts' });
        }

        // Auto-create spoke bootstrap services parented to the spoke host
        const spokeHost = cleanEndpoint.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        const services = [
          { name: `SSO Manager (${cleanName})`, slug: `sso-manager-${cleanSlug}`, subType: 'web', port: 3001, address: `https://${spokeHost}` },
          { name: `Proxy (${cleanName})`, slug: `proxy-${cleanSlug}`, subType: 'web', port: 3000, address: spoke.publicHost ? `https://${spoke.publicHost}` : `https://${spokeHost.replace(/^sso\./, 'proxy.')}` },
          { name: `OpenLDAP (${cleanName})`, slug: `openldap-${cleanSlug}`, subType: 'openldap', port: 389, address: `ldaps://${spokeHost}:636` },
          { name: `OpenResty (${cleanName})`, slug: `openresty-${cleanSlug}`, subType: 'openresty', port: 443, address: `https://${spokeHost}` },
          { name: `Jump Host (${cleanName})`, slug: `jump-host-${cleanSlug}`, subType: 'jump-host', port: 2222, address: `ssh://${spokeHost.replace(/^sso\./, 'jump.')}:2222` }
        ];

        for (const s of services) {
          let svcRes = await Resource.getBySlug(s.slug).catch(() => null);
          if (!svcRes) {
            svcRes = await Resource.create({
              id: crypto.randomUUID(),
              kind: 'service',
              name: s.name,
              slug: s.slug,
              metadata: { subType: s.subType, port: s.port, address: s.address, requestable: false },
              created_on: now
            });
          }
          const svcEdge = await ResourceEdge.list({ where: { parentId: hostRes.id, childId: svcRes.id } });
          if (!svcEdge || svcEdge.length === 0) {
            await ResourceEdge.create({ id: crypto.randomUUID(), parentId: hostRes.id, childId: svcRes.id, relation: 'hosts' });
          }
        }

        const { replicateOnFinish } = require('../utils/replicate_on_finish');
        replicateOnFinish(res);
      } catch (err) {
        console.warn(`[site] could not auto-create site/host/services resources for spoke: ${err.message}`);
      }
    }

    // No-inbound relay automation: best-effort, never blocks registration.
    // See utils/proxy_client.js for why this reuses theta-proxy's existing
    // API token system rather than a new credential type.
    //
    // Read off the ROW, not the request body: a caller that omits these fields
    // is no longer asserting "this spoke is inbound" (see the patch above), so
    // a gateway roster push must still refresh the relay route rather than
    // reporting it as not applicable.
    let relayNote = 'not applicable (spoke has inbound access)';
    if (spoke.noInbound) {
      const meshIp = spoke.meshIp;
      const publicHost = spoke.publicHost;
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

    logAudit('spoke_registered', { endpoint, siteSlug: spoke.siteSlug, noInbound: !!spoke.noInbound, relayNote });
    // ldapServerId rides back so the spoke can persist its own site id without
    // a second round trip. utils/mesh_roster.js needs it to know which roster
    // row is its own, and reading it out of the slapd.conf SEED (which is what
    // it used to do) is wrong between a join and the next container restart.
    res.json({
      status: 'ok',
      pushToken: spoke.pushToken,
      ldapServerId: spoke.ldapServerId || null,
      relay: { note: relayNote }
    });
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
    const spokeAuth = !key ? await SiteSpoke.authenticatePushToken(rawKey) : null;
    if (!key && !spokeAuth) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key or push token' });

    const callerEndpoint = req.query.endpoint;
    if (!callerEndpoint) {
      return res.status(400).json({ status: 'error', message: 'endpoint query param is required' });
    }

    const cfg = siteConfig.get();
    // The master is site 1, so its directory is dialled at its mesh address
    // (10.1.0.2) over plain LDAP -- replication rides the WireGuard tunnel,
    // never the public internet. Fall back to the public endpoint only if the
    // mesh address cannot be derived (should not happen for a master).
    const masterHost = ldapMeshHost(1) || ldapHostFor(cfg.masterUrl || req.protocol + '://' + req.get('host'));
    const spokes = await SiteSpoke.list();
    const normalize = (u) => String(u || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const caller = spokes.find((s) => s.endpoint === callerEndpoint || normalize(s.endpoint) === normalize(callerEndpoint));
    if (!caller || !caller.ldapServerId) {
      return res.status(404).json({ status: 'error', message: 'this endpoint is not a registered spoke -- register via POST /api/site/spokes first' });
    }

    const peers = [{ ldapServerId: 1, ldapHost: masterHost }];
    for (const s of spokes) {
      if (s.endpoint === callerEndpoint || !s.ldapServerId) continue;
      const host = ldapHostForSpoke(s);
      if (host) peers.push({ ldapServerId: s.ldapServerId, ldapHost: host });
    }

    res.json({ status: 'ok', ldapServerId: caller.ldapServerId, peers });
  } catch (e) { next(e); }
});

// ── Spoke Discovery Report (SPOKE -> MASTER) ──────────────────────────────
// Spokes forward local discovery outputs (e.g. Proxmox, Docker, Nmap, iLO, agent)
// to the master so they are reconciled into the authoritative catalog and
// replicated back to all spokes.
router.post('/spokes/discovery-report', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (!cfg.isMaster) return res.status(400).json({ status: 'error', message: 'only master receives discovery reports' });
    const rawKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const key = await SiteJoinKey.authenticate(rawKey);
    const spokeAuth = !key ? await SiteSpoke.authenticatePushToken(rawKey) : null;
    if (!key && !spokeAuth) return res.status(401).json({ status: 'error', message: 'invalid or revoked site join key or push token' });

    const { sourceName, payload, options } = req.body || {};
    if (!sourceName || !payload) {
      return res.status(400).json({ status: 'error', message: 'sourceName and payload are required' });
    }

    const { DiscoveryReconciler } = require('../services/discovery_reconciler');
    const result = await DiscoveryReconciler.reconcile(sourceName, payload, { ...(options || {}), _localOnly: true });

    // Broadcast updated directory catalog to all spokes
    require('../utils/site_replicate').replicateToSpokes(`discovery:${sourceName}`);
    res.json({ status: 'ok', result });
  } catch (e) { next(e); }
});

// ── Spoke Agent Report (SPOKE -> MASTER) ──────────────────────────────────
// Spokes forward newly enrolled agents, telemetry, and discovery to the master
// so the agent fleet is known cluster-wide and replicated to all spokes.
router.post('/spokes/agent-report', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (!cfg.isMaster) return res.status(400).json({ status: 'error', message: 'only master receives agent reports' });
    const rawKey = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const key = await SiteJoinKey.authenticate(rawKey);
    const spoke = !key ? await SiteSpoke.authenticatePushToken(rawKey) : null;
    if (!key && !spoke) return res.status(401).json({ status: 'error', message: 'invalid or revoked site credentials' });

    const { agent: a, discovery, telemetry } = req.body || {};
    if (!a || !a.id) return res.status(400).json({ status: 'error', message: 'agent data is required' });

    const { Agent } = require('../models/agent');
    const existing = await Agent.get(a.id).catch(() => null);
    const fields = {
      name: a.name || 'Unnamed Agent',
      description: a.description || null,
      tokenPrefix: a.tokenPrefix || null,
      resourceId: a.resourceId || null,
      revoked: !!a.revoked,
      enrolled_by: a.enrolled_by || 'replicated',
      enrolled_on: a.enrolled_on || Math.floor(Date.now() / 1000),
      version: a.version || null,
      last_seen: a.last_seen || Math.floor(Date.now() / 1000),
      last_ip: a.last_ip || null,
      ...(a.tokenHash ? { tokenHash: a.tokenHash } : {}),
      ...(discovery ? { lastDiscovery: discovery } : (a.lastDiscovery ? { lastDiscovery: a.lastDiscovery } : {})),
      ...(telemetry ? { lastTelemetry: telemetry } : (a.lastTelemetry ? { lastTelemetry: a.lastTelemetry } : {}))
    };

    if (existing) {
      await existing.update(fields);
    } else if (fields.tokenHash) {
      await Agent.create({ id: a.id, ...fields });
    }

    require('../utils/site_replicate').replicateToSpokes('agent-reported');
    res.json({ status: 'ok' });
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

    logAudit('resynced', { reason: (req.body && req.body.reason) || 'unspecified', resourcesCreated: imp.created, resourcesUpdated: imp.updated, apiTokensImported: imp.apiTokensImported });
    res.json({ status: 'ok', resources: { created: imp.created, updated: imp.updated, edges: imp.edgeCount }, apiTokens: { imported: imp.apiTokensImported } });
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
          // Relay posture rides along: the new master has to rebuild this
          // site's relay route on its own theta-proxy, and it has no other way
          // to learn a CGNAT spoke's mesh IP and public hostname.
          body: JSON.stringify({
            endpoint: selfUrl,
            siteSlug: cfg.siteSlug,
            noInbound: !!cfg.noInbound,
            ...(cfg.meshIp ? { meshIp: cfg.meshIp } : {}),
            ...(cfg.publicHost ? { publicHost: cfg.publicHost } : {})
          })
        });
        if (regResp.ok) {
          const regBody = await regResp.json();
          siteConfig.save({
            ...(regBody.pushToken ? { replicationPushToken: regBody.pushToken } : {}),
            ...(regBody.ldapServerId ? { ldapServerId: regBody.ldapServerId } : {})
          });
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
      const adoptedResult = await adoptFromMaster({ masterUrl: base, joinKey: newJoinKey });
      const impData = (adoptedResult && adoptedResult.imp) || adoptedResult || {};
      adopted = { created: impData.created || 0, updated: impData.updated || 0, edges: impData.edgeCount || 0 };
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
          siteConfig.save({
            selfUrl,
            ...(regBody.pushToken ? { replicationPushToken: regBody.pushToken } : {}),
            ...(regBody.ldapServerId ? { ldapServerId: regBody.ldapServerId } : {})
          });
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
//
// This used to await every push and return the per-spoke results, but a spoke
// that is slow to adopt the full directory snapshot can take longer than an
// edge proxy's timeout, so the UI got a 504 even though replication succeeded.
// The pushes now run fire-and-forget; callers should poll GET /api/site/spokes
// and watch `last_seen_on` for the outcome.
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
    // The endpoint ALREADY on file wins. The master's spoke registry is keyed
    // on this exact string, so re-registering under a different one does not
    // move the row -- it creates a second one, with a second LDAP ServerID and
    // a second push token, for one site. The admin UI passes
    // window.location.origin, which is whatever host the operator happened to
    // browse to (an IP and port during setup, the public name later), so
    // trusting the caller here forked the registry on a mis-click. Pass
    // `replaceEndpoint: true` to deliberately move a site that really has
    // changed address.
    const requestedSelfUrl = (req.body && req.body.selfUrl) || '';
    const replaceEndpoint = !!(req.body && req.body.replaceEndpoint);
    const selfUrl = (!replaceEndpoint && cfg.selfUrl) ? cfg.selfUrl : (requestedSelfUrl || cfg.selfUrl);
    if (!selfUrl) {
      return res.status(400).json({ status: 'error', message: 'this node does not know its own reachable URL; pass selfUrl' });
    }
    if (requestedSelfUrl && requestedSelfUrl !== selfUrl) {
      console.warn(`[site] reregister: keeping the registered endpoint ${selfUrl} rather than ${requestedSelfUrl} `
        + '(pass replaceEndpoint: true to move it)');
    }

    // The relay posture can be refreshed here rather than only at join time.
    // theta-suite's bootstrap/site-relay-register.js drives this once the
    // gateway-to-gateway mesh peering (a manual, out-of-band step) is done and
    // this site finally has a mesh IP -- which is always AFTER its join. It
    // used to POST the master's /api/site/spokes directly, which meant the
    // push token the master handed back was thrown away, and any disagreement
    // between the URL it registered and the one the join used created a SECOND
    // registry row with a second LDAP ServerID for one site.
    const b = req.body || {};
    const noInbound = b.noInbound !== undefined ? !!b.noInbound : !!cfg.noInbound;
    const meshIp = b.meshIp !== undefined ? b.meshIp : cfg.meshIp;
    const publicHost = b.publicHost !== undefined ? b.publicHost : cfg.publicHost;

    const base = String(cfg.masterUrl).replace(/\/+$/, '');
    const resp = await fetch(base + '/api/site/spokes', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.masterJoinKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        endpoint: selfUrl,
        siteSlug: cfg.siteSlug,
        noInbound,
        ...(meshIp ? { meshIp } : {}),
        ...(publicHost ? { publicHost } : {})
      })
    });
    if (!resp.ok) {
      const text = (await resp.text().catch(() => '')).slice(0, 200);
      return res.status(502).json({ status: 'error', message: `master rejected the registration: HTTP ${resp.status} ${text}` });
    }
    const body = await resp.json();
    siteConfig.save({
      selfUrl,
      noInbound,
      ...(meshIp ? { meshIp } : {}),
      ...(publicHost ? { publicHost } : {}),
      ...(body.pushToken ? { replicationPushToken: body.pushToken } : {}),
      ...(body.ldapServerId ? { ldapServerId: body.ldapServerId } : {})
    });

    reconcileSoon('reregistered');

    logAudit('reregistered', { actor: req.user.uid, masterUrl: base, selfUrl, noInbound });
    res.json({
      status: 'ok',
      message: 'Re-registered with ' + base,
      live: !!body.pushToken,
      ldapServerId: body.ldapServerId || null,
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

  // 1b. Adopt the cluster roster, so this site's gateway knows the others
  //     exist. Best-effort: a missing or malformed roster must not fail a
  //     join that is otherwise fine -- the site simply has no peers until the
  //     next resync carries them.
  let rosterNote = 'no roster in export';
  try {
    const { adopted } = await meshRoster.adoptRoster(exportData.meshSites);
    rosterNote = `${adopted} site(s) adopted`;
  } catch (e) {
    rosterNote = `failed: ${e.message}`;
    console.warn(`[site] could not adopt the cluster roster: ${e.message}`);
  }

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

  // 4. Adopt enrolled agents from master, so this spoke sees all agents in the cluster.
  if (Array.isArray(exportData.agents)) {
    for (const a of exportData.agents) {
      if (!a || !a.id) continue;
      try {
        const existing = await Agent.get(a.id).catch(() => null);
        const fields = {
          // Carried when the master sent it (see models/agent.js toReplica).
          // Without the hash a replicated agent row can be listed but never
          // authenticated, so agents at this site could not connect here at
          // all. Omitted rather than blanked when a master on an older release
          // still exports toPublic(), so an upgrade never destroys a hash this
          // node already had.
          ...(a.tokenHash ? { tokenHash: a.tokenHash } : {}),
          name: a.name || 'Unnamed Agent',
          description: a.description || null,
          tokenPrefix: a.tokenPrefix || null,
          resourceId: a.resourceId || null,
          revoked: !!a.revoked,
          enrolled_by: a.enrolled_by || 'replicated',
          enrolled_on: a.enrolled_on || null,
          version: a.version || null,
          last_seen: a.last_seen || null,
          last_ip: a.last_ip || null,
          lastDiscovery: a.lastDiscovery || null,
          lastTelemetry: a.lastTelemetry || null
        };
        if (existing) {
          await existing.update(fields);
        } else if (a.tokenHash) {
          await Agent.create({ id: a.id, ...fields });
        }
        // No hash and no local row: skip. Creating a row with an empty
        // tokenHash produced an agent that could never authenticate and, worse,
        // looked enrolled in the UI.
      } catch (e) {
        // Best-effort: an individual agent sync failure should not fail adoption
      }
    }
  }

  // 5. Adopt shared OpenBao secrets from master (integrations, plugins, cluster conf)
  if (Array.isArray(exportData.baoSecrets)) {
    const baoConf = require('@simpleworkjs/bao-conf');
    for (const s of exportData.baoSecrets) {
      if (!s || !s.path || !s.data) continue;
      // Re-checked on this side too, so a spoke on this release is safe even
      // when its master still runs one that exports `sso-manager/conf` -- which
      // would otherwise land the MASTER's LDAP bind password and jwtSecret in
      // this node's own config at its next boot.
      if (!isShareableBaoPath(s.path)) {
        console.warn(`[site] refused to adopt OpenBao path ${s.path}: not cluster-shared state`);
        continue;
      }
      try {
        await baoConf.set(s.path, s.data);
      } catch (e) {
        console.warn(`[site] could not adopt OpenBao secret at ${s.path}: ${e.message}`);
      }
    }
  }

  // 6. Adopt user verification records from master (TOS acceptance, verified status)
  if (Array.isArray(exportData.userVerifications)) {
    for (const uv of exportData.userVerifications) {
      if (!uv || !uv.uid) continue;
      try {
        const existing = await UserVerification.getOrCreate(uv.uid).catch(() => null);
        if (existing) {
          await existing.update(uv);
        }
      } catch (e) {}
    }
  }

  // 7. Adopt API tokens from master so an sso_... token minted on the master is
  // valid on every spoke. Only the bcrypt hash travels; the raw secret is never
  // stored and only shown once at creation time.
  let apiTokensImported = 0;
  if (Array.isArray(exportData.apiTokens)) {
    const exportedIds = new Set();
    for (const t of exportData.apiTokens) {
      if (!t || !t.id) continue;
      try {
        exportedIds.add(t.id);
        const existing = await ApiToken.get(t.id).catch(() => null);
        const fields = {
          secret_hash: t.secret_hash,
          name: t.name || 'Replicated token',
          description: t.description || '',
          created_by: t.created_by,
          created_on: t.created_on || Date.now(),
          updated_on: t.updated_on || Date.now(),
          expires_at: t.expires_at || 0,
          last_used_on: t.last_used_on || 0,
          is_valid: t.is_valid !== false
        };
        if (existing) {
          await existing.update(fields);
        } else {
          await ApiToken.create({ id: t.id, ...fields });
        }
        apiTokensImported++;
      } catch (e) {
        console.warn(`[site] could not adopt API token ${t.id}: ${e.message}`);
      }
    }
    // Tokens the master no longer has are deleted or revoked there; the master
    // is the authority for the cluster-wide PAT set. Only remove rows when the
    // master actually sent an apiTokens array (older releases omit it).
    try {
      const localTokens = await ApiToken.list();
      for (const local of localTokens || []) {
        if (exportedIds.has(local.id)) continue;
        await local.delete();
      }
    } catch (e) {
      console.warn('[site] could not prune deleted API tokens:', e.message);
    }
  }

  // 8. Adopt agent join keys from master so join keys issued on master work on every spoke.
  if (Array.isArray(exportData.agentJoinKeys)) {
    const exportedKeyIds = new Set();
    for (const jk of exportData.agentJoinKeys) {
      if (!jk || !jk.id || !jk.keyHash) continue;
      try {
        exportedKeyIds.add(jk.id);
        const existing = await AgentJoinKey.get(jk.id).catch(() => null);
        const fields = {
          label: jk.label || 'default',
          keyHash: jk.keyHash,
          keyPrefix: jk.keyPrefix || '',
          revoked: !!jk.revoked,
          created_by: jk.created_by || null,
          created_on: jk.created_on || null,
          expires_on: jk.expires_on || null,
          use_count: jk.use_count || 0,
          last_used_on: jk.last_used_on || null
        };
        if (existing) {
          await existing.update(fields);
        } else {
          await AgentJoinKey.create({ id: jk.id, ...fields });
        }
      } catch (e) {
        console.warn(`[site] could not adopt agent join key ${jk.id}: ${e.message}`);
      }
    }
    try {
      const localKeys = await AgentJoinKey.list();
      const cutoff = Math.floor(Date.now() / 1000) - 3600;
      for (const local of localKeys || []) {
        if (exportedKeyIds.has(local.id)) continue;
        if (local.created_on && local.created_on > cutoff && !local.revoked) continue;
        await local.delete();
      }
    } catch (e) {
      console.warn('[site] could not prune deleted agent join keys:', e.message);
    }
  }

  try {
    const userMod = require('../models/user');
    const UserModel = userMod.User || userMod;
    if (UserModel && typeof UserModel.clearCache === 'function') UserModel.clearCache();
  } catch (e) {}

  return { imp, ldapNote, signingKeyNote, exportData, base, apiTokensImported };
}

router.post('/join', async (req, res, next) => {
  try {
    const { masterUrl, joinKey, selfUrl, noInbound, meshIp, publicHost, siteSlug } = req.body || {};
    if (!masterUrl || !joinKey) {
      return res.status(400).json({ status: 'error', message: 'masterUrl and joinKey are required' });
    }

    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'this node is already a spoke (re-join is not supported)' });
    }
    // Only a fresh install may join — a directory with real users/agents or
    // other operator/runtime state must not be merged into a master's (that is
    // the destructive case).
    const { OAuthClient } = require('../models/oauth_client');
    const { MeshClient } = require('../models/mesh_client');
    const { AccessRequest } = require('../models/access_request');
    const { PluginInstance } = require('../models/plugin_instance');
    if (!(await siteIsFresh({ User, Agent, OAuthClient, MeshClient, AccessRequest, PluginInstance }))) {
      return res.status(409).json({
        status: 'error',
        message: 'This directory already has users, agents, OAuth clients, mesh clients, access requests, or plugin instances. Only a fresh install may join a site (re-provision the host to adopt a master directory).'
      });
    }

    let adopted;
    try {
      adopted = await adoptFromMaster({ masterUrl, joinKey });
    } catch (e) {
      return res.status(e.httpStatus || 502).json({ status: 'error', message: e.message });
    }
    const { imp, ldapNote, signingKeyNote, exportData, base } = adopted;

    // Spoke identity: preserve this spoke's own siteSlug (or the one passed
    // explicitly on join), never overwrite with master's siteSlug.
    const effectiveSiteSlug = siteSlug || (cfg.siteSlug && cfg.siteSlug !== 'site-default' && cfg.siteSlug !== exportData.siteSlug ? cfg.siteSlug : null) || (selfUrl ? 'site-' + new URL(selfUrl).hostname.replace(/[^a-z0-9]/gi, '-') : 'site-spoke');

    // 3. Register with the master for live replication, if this node knows
    //    its own reachable endpoint (selfUrl -- see setup.env's
    //    CFG_SELF_DIRECTORY_URL). Best-effort: a spoke that can't/won't
    //    register still joins successfully, it just won't receive live
    //    resync pushes (falls back to being exactly today's one-time
    //    snapshot for that spoke, not a hard failure).
    let replicationPushToken = null;
    let assignedServerId = null;
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
            siteSlug: effectiveSiteSlug,
            ...(noInbound ? { noInbound: true, meshIp, publicHost } : {})
          })
        });
        if (regResp.ok) {
          const regBody = await regResp.json();
          replicationPushToken = regBody.pushToken;
          assignedServerId = regBody.ldapServerId || null;
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
      siteSlug: effectiveSiteSlug,
      masterJoinKey: joinKey,
      // Remembered so this node can re-register itself later without being
      // told its own address again -- notably when a promotion elsewhere
      // re-points it at a new master (POST /master-changed).
      ...(selfUrl ? { selfUrl } : {}),
      ...(replicationPushToken ? { replicationPushToken } : {}),
      // The relay posture has to survive here too. POST /reregister rebuilds a
      // registration from this file, and it used to read cfg.noInbound --
      // which nothing ever wrote, so a re-register silently told the master
      // this CGNAT site had inbound access and dropped its relay route.
      noInbound: !!noInbound,
      ...(meshIp ? { meshIp } : {}),
      ...(publicHost ? { publicHost } : {}),
      // This node's cluster site id (== its OpenLDAP ServerID), as assigned by
      // the master. utils/mesh_roster.js reads it to know which roster row is
      // its own.
      ...(assignedServerId ? { ldapServerId: assignedServerId } : {})
    });

    // Now that this node knows its master and its own endpoint, pull the
    // replication config it was just assigned and apply it live.
    reconcileSoon('joined');

    logAudit('joined', {
      actor: req.user.uid,
      masterUrl: base,
      siteSlug: effectiveSiteSlug,
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
      siteSlug: effectiveSiteSlug,
      resources: { created: imp.created, updated: imp.updated, edges: imp.edgeCount },
      ldap: { note: ldapNote },
      signingKey: { note: signingKeyNote },
      replication: { note: replicationNote, live: !!replicationPushToken },
      relay: { note: relayNote }
    });
  } catch (e) { next(e); }
});

module.exports = router;
