'use strict';

const express = require('express');
const middleware = require('../middleware/auth');
const permission = require('../utils/permission');
const agentManager = require('../utils/agent_manager');

const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

module.exports = function initAgentWebSockets(app) {
  // Only the WebSocket handler needs the WS server. The REST routes mounted
  // below (/api/agent/*) must work regardless of the WS server state -- gating
  // them on `app.wss` made them 404 whenever it wasn't initialized.
  if (app.wss) {
    app.wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') || req.headers['authorization'];

    if (!token) {
      ws.close(4001, 'Unauthorized: Missing token');
      return;
    }

    const remoteAddr = req.socket.remoteAddress;
    console.log(`[Theta Agent] Agent connected from ${remoteAddr} with token ${token.substring(0, 8)}...`);

    agentManager.registerAgent(token, ws, remoteAddr);

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (!data || typeof data.type !== 'string') return;

        const payload = data.payload || {};

        switch (data.type) {
          case 'discovery':
            agentManager.handleDiscovery(token, payload);
            if (app.io) app.io.emit('agent.discovery', { token, payload });
            break;
          case 'telemetry':
            agentManager.handleTelemetry(token, payload);
            if (app.io) app.io.emit('agent.telemetry', { token, payload });
            break;
          case 'heartbeat':
            agentManager.handleHeartbeat(token, payload, ws);
            break;
          case 'response':
            agentManager.handleResponse(token, payload);
            if (app.io) app.io.emit('agent.response', { token, payload });
            break;
          default:
            console.log(`[Theta Agent] Received message type '${data.type}' from ${token}`);
        }
      } catch (err) {
        console.error("[Theta Agent] Error parsing message:", err);
      }
    });

    ws.on('close', () => {
      console.log(`[Theta Agent] Agent disconnected (${token})`);
      agentManager.unregisterAgent(token, ws);
    });

    // Send initial welcome/config payload
    try {
      ws.send(JSON.stringify({
        type: 'config',
        payload: {
          message: 'Connected to SSO Manager C2',
          protocol_version: '1.1.0'
        }
      }));
    } catch (e) {}
  });
  } // end if (app.wss)

  // REST API routes for Agent Management (mounted under /api/agent). The agent
  // WebSocket (/api/agent/ws) is handled by the raw `wss` upgrade server in
  // bin/www with its own ?token= auth — unaffected by the express middleware
  // here. These REST routes are admin-facing, so they're auth + admin gated.
  const router = express.Router();
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

  router.get('/nodes', (req, res) => {
    res.json({
      status: 'ok',
      agents: agentManager.getConnectedAgents(),
      publicKey: agentManager.publicKeyPem
    });
  });

  router.post('/nodes/:token/command', (req, res) => {
    const { token } = req.params;
    const { command, payload, isHighRisk } = req.body;

    if (!command) {
      return res.status(400).json({ status: 'error', message: 'Command type is required' });
    }

    try {
      const HIGH_RISK_COMMANDS = ['reboot', 'service_restart', 'configure_ldap', 'arbitrary_bash', 'update_binary'];
      const requiresSigning = isHighRisk || HIGH_RISK_COMMANDS.includes(command);

      const msg = agentManager.sendCommand(token, command, payload || {}, requiresSigning);
      res.json({ status: 'ok', sentMessage: msg });
    } catch (err) {
      res.status(400).json({ status: 'error', message: err.message });
    }
  });

  app.use('/api/agent', router);
};
