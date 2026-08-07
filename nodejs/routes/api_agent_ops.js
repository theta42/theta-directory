'use strict';

// Agent-facing operations (DESIGN.md §5, §6). These are NOT admin-gated: the
// caller is the agent itself, authenticated by its own token (the same one it
// presents on its WSS channel). Mounted at /api/v1/agent.

const express = require('express');
const baoConf = require('@simpleworkjs/bao-conf');
const { authenticateAgent } = require('../utils/agent_auth');

const router = express.Router();

// POST /secrets — fetch node-scoped OpenBao secrets for the agent's own node.
//
//   { paths: ["secret/data/nodes/<agent-id>/db"] }
//   -> { status: "ok", secrets: { "secret/data/nodes/<agent-id>/db": { key: value } } }
//
// The agent may only read under its own node prefix (secret/data/nodes/<id>/*),
// so a compromised agent cannot reach other nodes' or shared secrets. The SSO
// fetches with its own OpenBao access (SSO_VAULT_TOKEN); the agent never holds a
// Vault token.
router.post('/secrets', async (req, res, next) => {
	try {
		const agent = await authenticateAgent(req);
		if (!agent) return res.status(401).json({ status: 'error', message: 'unauthorized' });

		const { paths } = req.body || {};
		if (!Array.isArray(paths) || paths.length === 0) {
			return res.status(400).json({ status: 'error', message: 'paths (array) is required' });
		}

		const nodeScope = `secret/data/nodes/${agent.id}/`;
		const secrets = {};
		for (const p of paths) {
			if (typeof p !== 'string' || !p.startsWith(nodeScope)) {
				return res.status(403).json({ status: 'error', message: `path outside node scope: ${p}` });
			}
			const r = await baoConf.request('GET', p);
			if (r.ok) {
				const body = await r.json().catch(() => ({}));
				secrets[p] = (body.data && body.data.data) || {};
			} else {
				// Missing secret: return an empty object for that path rather than
				// failing the whole batch; the agent renders what it can.
				secrets[p] = {};
			}
		}

		return res.json({ status: 'ok', secrets });
	} catch (err) { next(err); }
});

module.exports = router;
