'use strict';

const express = require('express');
const middleware = require('../middleware/auth');
const permission = require('../utils/permission');
const agentManager = require('../utils/agent_manager');
const agentKeys = require('../utils/agent_keys');
const { Agent } = require('../models/agent');

const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

// Commands that can change or run code on the host. They are signed with the
// SSO's persisted Ed25519 key and the agent verifies against the key pinned in
// its agent.yml.
const HIGH_RISK_COMMANDS = ['reboot', 'service_restart', 'configure_ldap', 'arbitrary_bash', 'update_binary'];

// ── REST API (mounted synchronously in app.js, BEFORE the 404 catch-all) ──
// This is a plain Express Router exported directly so app.js can
// `app.use('/api/agent', require('./routes/api_agent'))` at require time. It
// must NOT be mounted from the onListen hook (which runs after the 404
// catch-all is already on the stack): a router registered behind that terminal
// handler would make every /api/agent/* request 404, no matter the WS server
// state. The WebSocket handler is separate (initAgentWebSockets below) and is
// the only part that needs the post-listen onListen hook.
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
    const { name, resourceId, description } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ status: 'error', message: 'name is required' });
    }

    if (resourceId) {
      const { Resource } = require('../models/resource');
      const resource = await Resource.get(resourceId);
      if (!resource) return res.status(400).json({ status: 'error', message: 'resourceId does not exist' });
      if (resource.kind !== 'host') {
        return res.status(400).json({ status: 'error', message: 'an agent can only be bound to a host resource' });
      }
    }

    const { agent, token } = await Agent.enroll({
      name: String(name).trim(),
      description,
      resourceId: resourceId || null,
      enrolledBy: req.user.uid
    });

    logAgentAudit('enroll', { actor: req.user.uid, agentId: agent.id, agentName: agent.name, resourceId: resourceId || null });

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
        if (resource.kind !== 'host') {
          return res.status(400).json({ status: 'error', message: 'an agent can only be bound to a host resource' });
        }
      }
      patch.resourceId = req.body.resourceId || null;
    }

    const updated = await agent.update(patch);
    logAgentAudit('update', { actor: req.user.uid, agentId: agent.id, fields: Object.keys(patch) });
    res.json({ status: 'ok', agent: updated.toPublic(agentManager.liveState(agent.id)) });
  } catch (err) { next(err); }
});

// Revoke: the token stops authenticating immediately and any live socket is
// dropped, so revocation takes effect without waiting for a reconnect.
router.post('/nodes/:id/revoke', async (req, res, next) => {
  try {
    const agent = await Agent.get(req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'agent not found' });
    await agent.update({ revoked: true });
    agentManager.disconnect(agent.id, 4003, 'Enrollment revoked');
    logAgentAudit('revoke', { actor: req.user.uid, agentId: agent.id, agentName: agent.name });
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
    res.json({ status: 'ok', token, publicKey: await agentManager.publicKeyBase64() });
  } catch (err) { next(err); }
});

router.delete('/nodes/:id', async (req, res, next) => {
  try {
    const agent = await Agent.get(req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'agent not found' });
    agentManager.disconnect(agent.id, 4003, 'Enrollment deleted');
    await agent.delete();
    logAgentAudit('delete', { actor: req.user.uid, agentId: agent.id, agentName: agent.name });
    res.json({ status: 'ok' });
  } catch (err) { next(err); }
});

// --- Commands ---
// Addressed by agent id, not by token: a token is a credential and has no
// business travelling in a URL, being logged, or sitting in browser history.
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
    const msg = await agentManager.sendCommand(agent, command, payload || {}, requiresSigning);

    logAgentAudit('command', {
      actor: req.user.uid,
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
    try {
      agent = await Agent.authenticate(token);
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
            if (app.io) app.io.emit('agent.discovery', { agentId: current.id, payload });
            break;
          case 'telemetry':
            await agentManager.handleTelemetry(current, payload);
            if (app.io) app.io.emit('agent.telemetry', { agentId: current.id, payload });
            break;
          case 'heartbeat':
            await agentManager.handleHeartbeat(current, payload, ws);
            break;
          case 'response':
            await agentManager.handleResponse(current, payload);
            if (app.io) app.io.emit('agent.response', { agentId: current.id, payload });
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
    });

    // Send initial welcome/config payload
    try {
      ws.send(JSON.stringify({
        type: 'config',
        payload: {
          message: 'Connected to SSO Manager C2',
          protocol_version: '1.2.0',
          agent_id: agent.id
        }
      }));
    } catch (e) {}
  });
};
