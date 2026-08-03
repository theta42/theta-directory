'use strict';

const express = require('express');
const agentManager = require('../utils/agent_manager');

module.exports = function initAgentWebSockets(app) {
  if (!app.wss) {
    console.warn("WebSocket server for agents is not initialized.");
    return;
  }

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

  // REST API routes for Agent Management (mounted under /api/agent)
  const router = express.Router();

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
