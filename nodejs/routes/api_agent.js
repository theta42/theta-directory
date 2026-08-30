'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const middleware = require('../middleware/auth');
const permission = require('../utils/permission');
const agentManager = require('../utils/agent_manager');
const agentKeys = require('../utils/agent_keys');
const ldapTunnel = require('../utils/ldap_tunnel');
const { Agent, AgentJoinKey } = require('../models/agent');
const { replicateOnFinish } = require('../utils/replicate_on_finish');
const { isAgentService, ensureAgentService } = require('../utils/agent_binding');
const { resolveSiteHint, currentSite } = require('../utils/agent_site');

const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

// Commands that can change or run code on the host. They are signed with the
// SSO's persisted Ed25519 key and the agent verifies against the key pinned in
// its agent.yml.
const HIGH_RISK_COMMANDS = ['reboot', 'shutdown', 'service_restart', 'systemd_action', 'configure_ldap', 'arbitrary_bash', 'update_binary', 'render_secrets', 'iam_apply'];

// ── REST API (mounted synchronously in app.js, BEFORE the 404 catch-all) ──
// This is a plain Express Router exported directly so app.js can
// `app.use('/api/agent', require('./routes/api_agent'))` at require time. It
// must NOT be mounted from the onListen hook (which runs after the 404
// catch-all is already on the stack): a router registered behind that terminal
// handler would make every /api/agent/* request 404, no matter the WS server
// state. The WebSocket handler is separate (initAgentWebSockets below) and is
// the only part that needs the post-listen onListen hook.
// Agent pushes go through the same per-socket read gate as model events.
// These were bare `app.io.emit` calls: every telemetry frame, discovery
// result and command OUTPUT to every authenticated socket, unfiltered.
const socketPubsub = require('../utils/socket_pubsub');

const router = express.Router();

// Structured audit line for anything that reaches a host. The agent channel can
// run arbitrary bash, so "who told which host to do what" has to be recoverable
// after the fact; previously nothing was recorded at all.
function logAgentAudit(action, details) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    component: 'agent',
    action,
    ...details
  }));
}

async function pushAgentToMaster(agent, token) {
  const siteConfig = require('../utils/site_config');
  const cfg = siteConfig.get();
  if (cfg.isMaster || !cfg.masterUrl || (!cfg.masterJoinKey && !cfg.replicationPushToken)) return;
  try {
    const { fetchWithAuthRedirect } = require('../utils/fetch_with_auth_redirect');
    const targetUrl = String(cfg.masterUrl).replace(/\/+$/, '') + '/api/site/spokes/agent-report';
    await fetchWithAuthRedirect(targetUrl, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (cfg.replicationPushToken || cfg.masterJoinKey), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          tokenHash: agent.tokenHash,
          tokenPrefix: agent.tokenPrefix,
          resourceId: agent.resourceId,
          revoked: agent.revoked,
          enrolled_by: agent.enrolled_by,
          enrolled_on: agent.enrolled_on,
          version: agent.version,
          last_seen: agent.last_seen,
          last_ip: agent.last_ip,
          lastDiscovery: agent.lastDiscovery,
          lastTelemetry: agent.lastTelemetry
        }
      })
    }, { timeoutMs: 10000 });
  } catch (err) {
    console.warn(`[Theta Agent] could not push agent ${agent.name} to master: ${err.message}`);
  }
}

async function dispatchCommandClusterWide(agent, command, payload, requiresSigning, req) {
  if (agentManager.isConnected(agent.id)) {
    return await agentManager.sendCommand(agent, command, payload, requiresSigning);
  }

  // Multi-site command routing: if this request was already forwarded, don't re-forward to avoid loops
  if (req && (req.header('x-command-routed') || req.forwardedFromSpoke)) {
    throw new Error(`Agent "${agent.name}" is not connected to this node`);
  }

  const siteConfig = require('../utils/site_config');
  const cfg = siteConfig.get();
  const { fetchWithAuthRedirect } = require('../utils/fetch_with_auth_redirect');

  if (!cfg.isMaster && cfg.masterUrl && (cfg.replicationPushToken || cfg.masterJoinKey)) {
    // Spoke -> Master
    const targetUrl = String(cfg.masterUrl).replace(/\/+$/, '') + `/api/agent/nodes/${agent.id}/command`;
    const token = cfg.replicationPushToken || cfg.masterJoinKey;
    // Sign the forwarded command (H-14): bind uid + path + timestamp so the
    // master can verify the request was really sent by a holder of this
    // spoke's push token. No 'admin' default: a missing actor is a hard fail.
    const fwdAuth = require('../utils/forwarded_auth_hmac');
    const actorUid = req.user && req.user.uid;
    if (!actorUid) {
      throw new Error(`Cannot forward command: no authenticated actor`);
    }
    const ts = String(Date.now());
    const cmdPath = `/api/agent/nodes/${agent.id}/command`;
    const resp = await fetchWithAuthRedirect(targetUrl, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'X-Forwarded-User': actorUid,
        'X-Forwarded-Ts': ts,
        'X-Forwarded-Mac': fwdAuth.sign(token, actorUid, ts, cmdPath),
        'X-Command-Routed': '1',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ command, payload, isHighRisk: requiresSigning })
    }, { timeoutMs: 15000 });
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return data.sentMessage || data;
    }
    const errBody = await resp.json().catch(() => ({}));
    throw new Error(errBody.message || `Master returned HTTP ${resp.status}`);
  } else if (cfg.isMaster) {
    // Master -> Spokes
    const { SiteSpoke } = require('../models/site_spoke');
    const spokes = await SiteSpoke.list();
    for (const spoke of spokes) {
      if (!spoke.endpoint || !spoke.pushToken) continue;
      try {
        const targetUrl = String(spoke.endpoint).replace(/\/+$/, '') + `/api/agent/nodes/${agent.id}/command`;
        // Sign the forwarded command (H-14): the spoke verifies the HMAC
        // keyed by its own push token before trusting X-Forwarded-User.
        const fwdAuth = require('../utils/forwarded_auth_hmac');
        const actorUid = req.user && req.user.uid;
        if (!actorUid) {
          // No resolvable actor — do not invent an 'admin' identity; skip
          // this spoke rather than attribute the action to a god user.
          continue;
        }
        const ts = String(Date.now());
        const cmdPath = `/api/agent/nodes/${agent.id}/command`;
        const signHeaders = {
          'Authorization': 'Bearer ' + spoke.pushToken,
          'X-Forwarded-User': actorUid,
          'X-Forwarded-Ts': ts,
          'X-Forwarded-Mac': fwdAuth.sign(spoke.pushToken, actorUid, ts, cmdPath),
          'X-Command-Routed': '1',
          'Content-Type': 'application/json'
        };
        const resp = await fetchWithAuthRedirect(targetUrl, {
          method: 'POST',
          headers: signHeaders,
          body: JSON.stringify({ command, payload, isHighRisk: requiresSigning })
        }, { timeoutMs: 5000 });
        if (resp.ok) {
          const data = await resp.json().catch(() => ({}));
          return data.sentMessage || data;
        }
      } catch (e) {
        // Try next spoke
      }
    }
  }

  throw new Error(`Agent "${agent.name}" is not connected`);
}

// The agent WebSocket (/api/agent/ws) authenticates its own token against the
// Agent table (see initAgentWebSockets). These REST routes are admin-facing, so
// they're auth + admin gated.
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

// --- Fleet ---
router.get('/nodes', async (req, res, next) => {
  try {
    const keyStatus = agentKeys.status();
    res.json({
      status: 'ok',
      agents: await agentManager.listAgents(),
      // Base64 of the raw 32-byte key: what goes into agent.yml's `public_key`.
      publicKey: await agentManager.publicKeyBase64(),
      publicKeyPem: await agentManager.publicKeyPem(),
      signingAvailable: agentKeys.status().available,
      signingError: keyStatus.error || null
    });
  } catch (err) { next(err); }
});

// --- Enrollment ---
// The token is minted HERE, not in the browser. It is returned exactly once;
// only its hash is stored, so it cannot be recovered afterwards -- rotate to
// get a new one.
router.post('/enroll', async (req, res, next) => {
  try {
    const { name, resourceId, siteId, description } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ status: 'error', message: 'name is required' });
    }
    if (resourceId && siteId) {
      return res.status(400).json({
        status: 'error',
        message: 'pass resourceId (bind to an existing host) or siteId (create a host), not both'
      });
    }

    const { Resource } = require('../models/resource');
    if (resourceId) {
      const resource = await Resource.get(resourceId);
      if (!resource) return res.status(400).json({ status: 'error', message: 'resourceId does not exist' });
      if (resource.kind !== 'host') {
        return res.status(400).json({ status: 'error', message: 'an agent can only be bound to a host resource' });
      }
    }
    // siteId is the operator-driven mirror of join-key self-enrolment: the
    // host does not exist yet, so the directory creates it under the named
    // site along with the agent's service. Without this, enrolling from the UI
    // required creating the host by hand first.
    if (siteId) {
      const site = await Resource.get(siteId).catch(() => null);
      if (!site || site.kind !== 'site') {
        return res.status(400).json({ status: 'error', message: 'siteId must refer to a site resource' });
      }
    }

    const { agent, token } = await Agent.enroll({
      name: String(name).trim(),
      description,
      resourceId: resourceId || null,
      siteId: siteId || null,
      enrolledBy: req.user.uid
    });

    logAgentAudit('enroll', {
      actor: req.user.uid, agentId: agent.id, agentName: agent.name,
      resourceId: agent.resourceId || null, siteId: siteId || null
    });

    replicateOnFinish(res, 'agent-enrolled');
    pushAgentToMaster(agent, token);

    const publicKey = await agentManager.publicKeyBase64();
    res.json({
      status: 'ok',
      agent: agent.toPublic(agentManager.liveState(agent.id)),
      // Shown once. The UI must make that clear.
      token,
      publicKey,
      signingAvailable: agentKeys.status().available
    });
  } catch (err) { next(err); }
});

router.put('/nodes/:id', async (req, res, next) => {
  try {
    const agent = await Agent.get(req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'agent not found' });

    const patch = {};
    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.description !== undefined) patch.description = req.body.description;
    if (req.body.resourceId !== undefined) {
      if (req.body.resourceId) {
        const { Resource } = require('../models/resource');
        const resource = await Resource.get(req.body.resourceId);
        if (!resource) return res.status(400).json({ status: 'error', message: 'resourceId does not exist' });
        // A host is accepted as a convenience -- it is what an operator picks
        // in the UI -- but the binding itself is always to the host's
        // theta-agent service.
        if (resource.kind === 'host') {
          patch.resourceId = (await ensureAgentService(resource)).id;
        } else if (isAgentService(resource)) {
          patch.resourceId = resource.id;
        } else {
          return res.status(400).json({
            status: 'error',
            message: 'an agent can only be bound to a host or to a theta-agent service resource'
          });
        }
      } else {
        patch.resourceId = null;
      }
    }

    const updated = await agent.update(patch);
    logAgentAudit('update', { actor: req.user.uid, agentId: agent.id, fields: Object.keys(patch) });
    replicateOnFinish(res, 'agent-updated');
    pushAgentToMaster(updated);
    res.json({ status: 'ok', agent: updated.toPublic(agentManager.liveState(agent.id)) });
  } catch (err) { next(err); }
});


// Remove the theta-agent service child and any edges when an enrollment is
// revoked or deleted. The host itself is preserved as a catalog resource; only
// the graph link to the agent is removed.
async function unbindAgentFromResources(agent) {
  try {
    const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
    if (!agent.resourceId) return;
    const serviceRes = await Resource.get(agent.resourceId).catch(() => null);
    if (!isAgentService(serviceRes)) return;

    // Dependents FIRST, both directions, same ordering rule as
    // DELETE /api/directory-admin/resources/:id: there is no transaction here,
    // so a row deleted before its edges leaves edges pointing at an id that no
    // longer exists -- invisible in the UI and poisonous to getGraph().
    const [asChild, asParent, groups] = await Promise.all([
      ResourceEdge.list({ where: { childId: serviceRes.id } }).catch(() => []),
      ResourceEdge.list({ where: { parentId: serviceRes.id } }).catch(() => []),
      ResourceGroup.list({ where: { resourceId: serviceRes.id } }).catch(() => [])
    ]);
    for (const g of groups) await g.delete().catch(() => {});
    for (const e of [...asChild, ...asParent]) await e.delete().catch(() => {});
    await serviceRes.delete().catch(() => {});
  } catch (err) {
    console.error(`[api_agent] could not unbind agent ${agent.id} from its resources:`, err.message);
  }
}

// Revoke: the token stops authenticating immediately and any live socket is
// dropped, so revocation takes effect without waiting for a reconnect.
router.post('/nodes/:id/revoke', async (req, res, next) => {
  try {
    const agent = await Agent.get(req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'agent not found' });
    await agent.update({ revoked: true });
    await unbindAgentFromResources(agent);
    agentManager.disconnect(agent.id, 4003, 'Enrollment revoked');
    logAgentAudit('revoke', { actor: req.user.uid, agentId: agent.id, agentName: agent.name });
    replicateOnFinish(res, 'agent-revoked');
    pushAgentToMaster(agent);
    res.json({ status: 'ok' });
  } catch (err) { next(err); }
});

router.post('/nodes/:id/rotate', async (req, res, next) => {
  try {
    const agent = await Agent.get(req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'agent not found' });
    const token = await agent.rotateToken();
    // The old token is dead the moment it is replaced; drop the socket that was
    // using it so the agent reconnects with the new one.
    agentManager.disconnect(agent.id, 4004, 'Token rotated');
    logAgentAudit('rotate', { actor: req.user.uid, agentId: agent.id, agentName: agent.name });
    replicateOnFinish(res, 'agent-token-rotated');
    pushAgentToMaster(agent, token);
    res.json({ status: 'ok', token, publicKey: await agentManager.publicKeyBase64() });
  } catch (err) { next(err); }
});

router.delete('/nodes/:id', async (req, res, next) => {
  try {
    const agent = await Agent.get(req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'agent not found' });
    agentManager.disconnect(agent.id, 4003, 'Enrollment deleted');
    await unbindAgentFromResources(agent);
    await agent.delete();
    logAgentAudit('delete', { actor: req.user.uid, agentId: agent.id, agentName: agent.name });
    replicateOnFinish(res, 'agent-deleted');
    res.json({ status: 'ok' });
  } catch (err) { next(err); }
});

// --- Join keys ---
// One key an operator hands out; hosts that present it enroll themselves and
// are immediately issued their own per-agent token. Listing never returns the
// key itself -- only its prefix and usage.
router.get('/join-keys', async (req, res, next) => {
  try {
    const keys = await AgentJoinKey.list();
    res.json({ status: 'ok', joinKeys: keys.map(k => k.toPublic()) });
  } catch (err) { next(err); }
});

// Which hosts enrolled through a given key. There is no stored relation --
// join keys are exchanged for a per-agent token immediately, and from then on
// the agent's own identity is what matters -- so this matches on the
// human-readable trace `Agent.enroll` already leaves in `description`
// ("Self-enrolled with join key <prefix>") rather than a foreign key. Prefixes
// are 12 random hex chars, so a collision is not a practical concern.
router.get('/join-keys/:id/agents', async (req, res, next) => {
  try {
    const key = await AgentJoinKey.get(req.params.id);
    if (!key) return res.status(404).json({ status: 'error', message: 'join key not found' });
    const marker = `join key ${key.keyPrefix}`;
    const agents = await Agent.list();
    const matches = agents.filter(a => (a.description || '').includes(marker));
    res.json({ status: 'ok', agents: matches.map(a => a.toPublic(agentManager.liveState(a.id))) });
  } catch (err) { next(err); }
});

router.post('/join-keys', async (req, res, next) => {
  try {
    const { label, expiresInDays, maxUses } = req.body || {};
    const { key, raw } = await AgentJoinKey.issue({
      label: (label && String(label).trim()) || 'default',
      createdBy: req.user.uid,
      expiresInDays: expiresInDays ? Number(expiresInDays) : null,
      maxUses: maxUses ? Number(maxUses) : null
    });
    logAgentAudit('join_key_issued', { actor: req.user.uid, label: key.label, keyPrefix: key.keyPrefix });
    replicateOnFinish(res, 'agent-join-key-issued');
    // Shown once; only the hash is stored.
    res.json({ status: 'ok', joinKey: key.toPublic(), key: raw });
  } catch (err) { next(err); }
});

router.post('/join-keys/:id/revoke', async (req, res, next) => {
  try {
    const key = await AgentJoinKey.get(req.params.id);
    if (!key) return res.status(404).json({ status: 'error', message: 'join key not found' });
    await key.update({ revoked: true });
    logAgentAudit('join_key_revoked', { actor: req.user.uid, label: key.label, keyPrefix: key.keyPrefix });
    replicateOnFinish(res, 'agent-join-key-revoked');
    // Agents already enrolled keep working -- they hold their own tokens now,
    // which is the whole point of exchanging the join key rather than using it
    // as the long-term credential.
    res.json({ status: 'ok' });
  } catch (err) { next(err); }
});

// --- Staged artifacts ---
// The Download modal's artifact table is generated from what setup.sh staged
// into public/resources/theta-agent/ (bind-mounted from ./config/resources),
// not from a hardcoded list: the release gains artifacts and the UI follows
// without a code change. The artifact set is the pinned theta-agent release's
// SHA256SUMS contents, plus the stable Windows-installer alias install.sh
// copies it to. Staging states are surfaced so the modal can flag anything a
// fresh setup has not fetched yet (offline host, partial mirror).
//
// The release version is read from the versioned Windows installer name
// (theta-agent-<version>-windows-amd64-setup.exe) — the only artifact that
// carries the version; the agent/tray/helper binaries keep the stable names
// the agent's self-update fetches.
const AGENT_ARTIFACTS_DIR = path.join(__dirname, '..', 'public', 'resources', 'theta-agent');

const AGENT_ARTIFACTS = [
  { id: 'install', file: 'install.sh', purpose: 'Linux bootstrap script — fetches and configures the agent binary' },
  { id: 'winsetup', file: 'theta-agent-windows-amd64-setup.exe', purpose: 'Windows installer (agent, tray, WireGuard, credential provider)' },
  { id: 'sums', file: 'SHA256SUMS', purpose: 'Checksums for every staged artifact — verify before running' },
  { id: 'linux-amd64', file: 'theta-agent-linux-amd64', purpose: 'Linux agent binary (x86-64)' },
  { id: 'linux-arm64', file: 'theta-agent-linux-arm64', purpose: 'Linux agent binary (ARM 64-bit)' },
  { id: 'linux-armv7', file: 'theta-agent-linux-armv7', purpose: 'Linux agent binary (ARM 32-bit)' },
  { id: 'win-amd64', file: 'theta-agent-windows-amd64.exe', purpose: 'Windows agent binary (x86-64, no installer)' },
  { id: 'win-arm64', file: 'theta-agent-windows-arm64.exe', purpose: 'Windows agent binary (ARM 64-bit, no installer)' },
  { id: 'tray-linux-amd64', file: 'theta-agent-tray-linux-amd64', purpose: 'Linux desktop tray companion (x86-64)' },
  { id: 'tray-linux-arm64', file: 'theta-agent-tray-linux-arm64', purpose: 'Linux desktop tray companion (ARM 64-bit)' },
  { id: 'tray-win-amd64', file: 'theta-agent-tray-windows-amd64.exe', purpose: 'Windows tray companion (x86-64)' },
  { id: 'tray-win-arm64', file: 'theta-agent-tray-windows-arm64.exe', purpose: 'Windows tray companion (ARM 64-bit)' },
  { id: 'helper-win-amd64', file: 'theta-agent-helper-windows-amd64.exe', purpose: 'Windows session helper (x86-64)' },
  { id: 'helper-win-arm64', file: 'theta-agent-helper-windows-arm64.exe', purpose: 'Windows session helper (ARM 64-bit)' }
];

function stagedAgentState() {
  try {
    return new Set(fs.readdirSync(AGENT_ARTIFACTS_DIR));
  } catch (err) {
    return new Set();
  }
}

function stagedAgentVersion(names) {
  const m = /^theta-agent-([0-9]+\.[0-9]+\.[0-9]+)-windows-amd64-setup\.exe$/.exec(Array.from(names).find((n) => /^theta-agent-[0-9]+\.[0-9]+\.[0-9]+-windows-amd64-setup\.exe$/.test(n)) || '');
  return m ? m[1] : null;
}

// Every catalog entry is reported so the table can show what is missing; a
// file is staged only when it exists on disk. Size is the on-disk byte count
// (null when not staged or unreadable).
router.get('/artifacts', async (req, res, next) => {
  try {
    const names = stagedAgentState();
    const artifacts = AGENT_ARTIFACTS.map((entry) => {
      const staged = names.has(entry.file);
      let size = null;
      if (staged) {
        try {
          const st = fs.statSync(path.join(AGENT_ARTIFACTS_DIR, entry.file));
          if (st.isFile()) size = st.size;
        } catch (err) { /* file vanished between readdir and stat */ }
      }
      return { id: entry.id, file: entry.file, purpose: entry.purpose, staged, size };
    });
    res.json({ status: 'ok', version: stagedAgentVersion(names), artifacts });
  } catch (err) { next(err); }
});

// --- Commands ---
// Addressed by agent id, not by token: a token is a credential and has no
// business travelling in a URL, being logged, or sitting in a browser history.
router.post('/nodes/:id/command', async (req, res, next) => {
  const { command, payload, isHighRisk } = req.body || {};
  if (!command) {
    return res.status(400).json({ status: 'error', message: 'Command type is required' });
  }
  try {
    const agent = await Agent.get(req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'agent not found' });
    if (agent.revoked) return res.status(403).json({ status: 'error', message: 'agent enrollment is revoked' });

    const requiresSigning = isHighRisk || HIGH_RISK_COMMANDS.includes(command);
    const msg = await dispatchCommandClusterWide(agent, command, payload || {}, requiresSigning, req);

    logAgentAudit('command', {
      actor: req.user && req.user.uid,
      agentId: agent.id,
      agentName: agent.name,
      resourceId: agent.resourceId || null,
      command,
      signed: requiresSigning
    });

    res.json({ status: 'ok', sentMessage: msg });
  } catch (err) {
    logAgentAudit('command_failed', { actor: req.user && req.user.uid, agentId: req.params.id, command, error: err.message });
    res.status(400).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
module.exports.HIGH_RISK_COMMANDS = HIGH_RISK_COMMANDS;

module.exports.initAgentWebSockets = function initAgentWebSockets(app) {
  // WebSocket handler only needs the WS server; runs from the onListen hook.
  if (!app.wss) return;

  // Warm the signing key at boot so a misconfigured OpenBao policy is a loud
  // startup error rather than a surprise the first time someone reboots a host.
  agentKeys.load().then(keys => {
    if (!keys) console.error(`[Theta Agent] signing key unavailable — high-risk commands will be refused. ${agentKeys.status().error || ''}`);
  });

  app.wss.on('connection', async (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || req.headers['authorization'];
    const remoteAddr = req.socket.remoteAddress;

    // Authenticate BEFORE doing anything else: no registration, no welcome
    // payload, no acknowledgement that the token was close. Until this passes
    // the peer is an anonymous stranger, and the old code treated it as a
    // trusted node purely for presenting a non-empty string.
    let agent = null;
    let issuedToken = null;   // set when this connection auto-enrolled
    try {
      agent = await Agent.authenticate(token);

      // Not a known agent token -- try it as a join key. This is what makes
      // "install the agent with a key and the host appears" work without an
      // admin pre-registering every machine. The join key is exchanged for a
      // per-agent token below, so it never becomes the host's long-term
      // credential.
      if (!agent) {
        const joinKey = await AgentJoinKey.authenticate(token);
        if (joinKey) {
          const hostname = (url.searchParams.get('hostname') || '').trim();

          // The site the agent believes it is at: `location` from its config,
          // or the site of an mDNS announcement fronting the very host it is
          // talking to (theta-agent's resolveSiteHint, local_discovery.go).
          // Absent, the directory files the host under its own site.
          //
          // A hint that is PRESENT but matches nothing is rejected rather than
          // silently ignored: the agent is telling us it belongs somewhere
          // specific, and quietly filing it elsewhere is how a host ends up in
          // the wrong site inheriting the wrong access.
          const siteHint = (url.searchParams.get('site') || '').trim();
          const hasExplicitSite = siteHint && !['default', 'unknown', 'none'].includes(siteHint.toLowerCase());
          let site = null;
          if (hasExplicitSite) {
            site = await resolveSiteHint(siteHint);
            if (!site) {
              logAgentAudit('join_rejected', { remoteAddr, reason: 'site not found', site: siteHint });
              try { ws.close(4001, `Site not found: ${siteHint}`); } catch (e) {}
              return;
            }
          } else {
            site = await currentSite();
            if (!site) {
              logAgentAudit('join_rejected', { remoteAddr, reason: 'no current site' });
              try {
                ws.close(4001, 'This directory has no current site; pass ?site=<slug> or set one in the directory');
              } catch (e) {}
              return;
            }
          }
          let existingAgent = null;
          if (hostname) {
            const matches = await Agent.list({ where: { name: hostname } });
            existingAgent = matches && matches.find(a => !a.revoked);
          }
          if (existingAgent) {
            // Contract G-2: re-enrolling an existing host requires presenting
            // the agent's CURRENT token (?prev_token=). Without this, anyone
            // holding the join key could collide on the hostname and rotate
            // the real host's token, taking it over. A missing/incorrect
            // prev_token is rejected with 4001 (same as bad credential).
            const prevToken = url.searchParams.get('prev_token');
            const prevHash = prevToken ? Agent.hashToken(prevToken) : null;
            const knowsCurrent = prevHash && existingAgent.tokenHash === prevHash;
            if (!knowsCurrent) {
              logAgentAudit('join_rejected', {
                remoteAddr, reason: 'prev_token required for existing agent',
                agentId: existingAgent.id, agentName: existingAgent.name, hostname
              });
              try { ws.close(4001, 'prev_token required: this host is already enrolled'); } catch (e) {}
              return;
            }
            const newToken = await existingAgent.rotateToken();
            agent = existingAgent;
            issuedToken = newToken;
            require('../utils/site_replicate').replicateToSpokes('agent-token-rotated');
            pushAgentToMaster(agent, issuedToken);
          } else {
            const enrolled = await Agent.enroll({
              name: hostname || `agent-${Date.now().toString(36)}`,
              siteId: site.id,
              description: `Self-enrolled with join key ${joinKey.keyPrefix}`,
              enrolledBy: `join-key:${joinKey.label}`
            });
            agent = enrolled.agent;
            issuedToken = enrolled.token;
            require('../utils/site_replicate').replicateToSpokes('agent-enrolled');
            pushAgentToMaster(agent, issuedToken);
          }
          await joinKey.update({
            use_count: (joinKey.use_count || 0) + 1,
            last_used_on: Math.floor(Date.now() / 1000)
          }).catch(() => {});
          logAgentAudit('join', {
            agentId: agent.id, agentName: agent.name, remoteAddr,
            joinKeyLabel: joinKey.label, joinKeyPrefix: joinKey.keyPrefix
          });
          console.log(`[Theta Agent] "${agent.name}" self-enrolled with join key ${joinKey.keyPrefix}`);
        }
      }
    } catch (err) {
      console.error('[Theta Agent] authentication lookup failed:', err.message);
      try { ws.close(1011, 'Authentication unavailable'); } catch (e) {}
      return;
    }

    if (!agent) {
      // Deliberately indistinguishable for unknown vs revoked vs missing: a
      // caller probing tokens learns nothing about which part was wrong.
      logAgentAudit('auth_rejected', { remoteAddr, tokenPrefix: token ? String(token).slice(0, 8) : null });
      try { ws.close(4001, 'Unauthorized'); } catch (e) {}
      return;
    }

    console.log(`[Theta Agent] "${agent.name}" (${agent.id}) connected from ${remoteAddr}`);
    logAgentAudit('connected', { agentId: agent.id, agentName: agent.name, remoteAddr });
    // Must stay synchronous, and the listeners below must be attached in this
    // same tick: the agent sends `discovery` the instant the socket opens, and
    // `ws` discards messages emitted while no listener is attached.
    agentManager.registerAgent(agent, ws, remoteAddr);

    if (issuedToken) {
      const publicKey = await agentManager.publicKeyBase64();
      try {
        ws.send(JSON.stringify({
          type: 'config',
          payload: {
            enrolled: true,
            auth_token: issuedToken,
            public_key: publicKey
          }
        }));
        console.log(`[Theta Agent] Sent auto-enrollment credentials to "${agent.name}"`);
      } catch (err) {
        console.error(`[Theta Agent] Failed to send auto-enrollment config to "${agent.name}":`, err.message);
      }
    }

    ws.on('message', async (message) => {
      try {
        const data = JSON.parse(message);
        if (!data || typeof data.type !== 'string') return;

        // Re-read the row per message so a revoke mid-session takes effect on
        // the next thing the agent says, not only on reconnect.
        const current = await Agent.get(agent.id).catch(() => null);
        if (!current || current.revoked) {
          try { ws.close(4003, 'Enrollment revoked'); } catch (e) {}
          return;
        }

        const payload = data.payload || {};

        switch (data.type) {
          case 'discovery':
            await agentManager.handleDiscovery(current, payload);
            socketPubsub.emitChannel(app.io, 'agent.discovery', { agentId: current.id, payload });
            if (payload.capabilities && payload.capabilities.configure_ldap) {
              const conf = require('@simpleworkjs/conf');
              const ssoHost = conf.stack && conf.stack.ssoHost;
              const ldapBaseDn = conf.stack && conf.stack.ldapBaseDn;
              // Refuse to push SSSD config when stack host/base are unset: a
              // missing host means this directory has not been told its own
              // address, and pushing a placeholder (or a dev default) would
              // point every agent at a host that is not us. The operator must
              // set stack.ssoHost / stack.ldapBaseDn (Directory → Settings).
              if (!ssoHost || !ldapBaseDn) {
                console.error(`[Theta Agent] Auto configure_ldap skipped for "${current.name}": stack.ssoHost / stack.ldapBaseDn not set`);
                logAgentAudit('configure_ldap_skipped', { agentId: current.id, agentName: current.name, reason: 'stack host/base not configured' });
                break;
              }

              // URI list is restricted to the local Unix socket, loopback, and
              // LDAPS on the configured SSO host only. Cleartext network URIs
              // (ldap:// to a LAN IP or the SSO host on 389) are dropped: SSSD
              // would happily send bind passwords in the clear, and a LAN IP
              // is not a stable directory address anyway.
              const uriList = [
                `ldapi://%2frun%2ftheta%2fldap.sock`,
                `ldap://127.0.0.1:3890`,
                `ldaps://${ssoHost}:636`,
              ];
              const ldapUris = [...new Set(uriList)].join(', ');

              const sssdConfig = `[sssd]
config_file_version = 2
domains = default

[domain/default]
id_provider = ldap
auth_provider = ldap
chpass_provider = ldap
sudo_provider = ldap
ldap_uri = ${ldapUris}
ldap_search_base = ${ldapBaseDn}
ldap_user_search_base = ou=people,${ldapBaseDn}
ldap_group_search_base = ou=groups,${ldapBaseDn}
ldap_sudo_search_base = ou=people,${ldapBaseDn}
ldap_schema = rfc2307bis
ldap_user_object_class = posixAccount
ldap_user_name = uid
ldap_user_ssh_public_key = sshPublicKey
ldap_group_object_class = groupOfNames
ldap_group_member = member
ldap_id_mapping = false
ldap_id_use_start_tls = false
ldap_tls_reqcert = never
cache_credentials = true
entry_cache_timeout = 600
entry_cache_user_timeout = 600
entry_cache_group_timeout = 600
entry_cache_sudo_timeout = 600
refresh_expired_interval = 300
`;
              agentManager.sendCommand(current, 'configure_ldap', { config: sssdConfig }, true).then(() => {
                console.log(`[Theta Agent] Pushed auto configure_ldap to "${current.name}"`);
              }).catch(err => {
                console.error(`[Theta Agent] Auto push configure_ldap to "${current.name}" failed:`, err.message);
              });
            }
            break;
          case 'telemetry':
            await agentManager.handleTelemetry(current, payload);
            socketPubsub.emitChannel(app.io, 'agent.telemetry', { agentId: current.id, payload });
            break;
          case 'register_service':
            try {
              await agentManager.handleServiceRegistration(current, payload);
              ws.send(JSON.stringify({ type: 'response', payload: { status: 'ok', message: 'service registered' } }));
            } catch (err) {
              console.error(`[Theta Agent] register_service for ${current.name} failed:`, err.message);
              ws.send(JSON.stringify({ type: 'response', payload: { status: 'error', message: err.message } }));
            }
            socketPubsub.emitChannel(app.io, 'agent.service_registered', { agentId: current.id, payload });
            break;
          case 'unregister_service':
            try {
              await agentManager.handleServiceUnregistration(current, payload);
              ws.send(JSON.stringify({ type: 'response', payload: { status: 'ok', message: 'service unregistered' } }));
            } catch (err) {
              console.error(`[Theta Agent] unregister_service for ${current.name} failed:`, err.message);
              ws.send(JSON.stringify({ type: 'response', payload: { status: 'error', message: err.message } }));
            }
            socketPubsub.emitChannel(app.io, 'agent.service_unregistered', { agentId: current.id, payload });
            break;
          case 'heartbeat':
            await agentManager.handleHeartbeat(current, payload, ws);
            break;
          case 'response':
            await agentManager.handleResponse(current, payload);
            socketPubsub.emitChannel(app.io, 'agent.response', { agentId: current.id, payload });
            break;
          case 'ldap_tunnel':
            // Raw LDAP bytes from the agent's local socket → relay into OpenLDAP
            // and pipe the response back (DESIGN.md §4).
            ldapTunnel.handleTunnel(current.id, ws, payload);
            break;
          default:
            console.log(`[Theta Agent] Received message type '${data.type}' from ${current.id}`);
        }
      } catch (err) {
        console.error('[Theta Agent] Error handling message:', err);
      }
    });

    ws.on('close', () => {
      console.log(`[Theta Agent] "${agent.name}" (${agent.id}) disconnected`);
      agentManager.unregisterAgent(agent.id, ws);
      // Scoped to THIS ws: an agent that reconnected already has relay
      // sockets on its new connection, and those must survive this close.
      ldapTunnel.cleanup(agent.id, ws);
    });

    // Send initial welcome/config payload. When this connection enrolled via a
    // join key it also carries the credentials the agent should persist and use
    // from now on: its own token, and the public key it must pin to verify
    // signed commands. Handing the public key over here is what removes the
    // last manual step -- an agent installed with only a join key ends up fully
    // configured without anyone copying values between two machines.
    try {
      const payload = {
        message: 'Connected to SSO Manager C2',
        protocol_version: '1.3.0',
        agent_id: agent.id
      };
      if (issuedToken) {
        payload.enrolled = true;
        payload.auth_token = issuedToken;
        payload.public_key = await agentManager.publicKeyBase64();
      }
      Object.assign(payload, await homeDetectHints());
      // White-label branding for the agent (tray + Windows logon tile).
      if (conf.name && conf.name !== 'SSO Manager') {
        payload.organization_name = conf.name;
      }
      ws.send(JSON.stringify({ type: 'config', payload }));
    } catch (e) {}
  });
};


// Home-detection hints for the agent (theta-agent home_reach.go).
//
// The agent has always READ `site_public_ip` off this payload -- but nothing in
// the suite ever sent it, so its homePublicIP stayed empty and its
// `|| homePublicIP == ""` fallback made every agent believe it was permanently
// at home. Auto-VPN could therefore never fire, because "away" never happened.
//
// Two hints, weakest last:
//
//   site_lan_endpoint  the site's resolver at its PHYSICAL LAN address. It
//                      only resolves/routes while the client is actually on
//                      that LAN, which is exactly the property home detection
//                      needs, so reaching it is conclusive.
//   site_public_ip     egress-address comparison. Kept as a fallback, but it
//                      is wrong under CGNAT (unrelated sites share an address)
//                      and at multi-WAN sites (several valid answers).
//
// Best-effort: a missing hint degrades detection, it must not break the
// agent's connection.
async function homeDetectHints() {
  const hints = {};
  try {
    const roster = require('../utils/mesh_roster');
    const siteId = roster.localSiteId();
    if (siteId) {
      const site = await roster.bySiteId(siteId);
      // dnsHost is a host ON the LAN, not its shadow address -- the shadow is
      // reachable over the mesh and so proves nothing about being home.
      if (site && site.dnsHost) hints.site_lan_endpoint = `${site.dnsHost}:53`;
    }
  } catch (e) { /* no mesh yet */ }

  try {
    const { Resource } = require('../models/resource');
    const sites = await Resource.list({ where: { kind: 'site' } });
    const local = sites.find((s) => s.metadata && s.metadata.isCurrentSite) || sites[0];
    const ip = local && local.metadata &&
      (local.metadata.public_ip || local.metadata.ip || local.metadata.address);
    if (ip) hints.site_public_ip = String(ip).trim();
  } catch (e) { /* no site resource yet */ }

  return hints;
}
