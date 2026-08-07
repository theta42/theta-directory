'use strict';

// Authenticate an agent from a Bearer token (the same token the agent presents
// on its WSS channel). Used by agent-facing REST endpoints (secrets, IAM) that
// are NOT admin-gated — the caller is the agent itself, not an admin session.

const { Agent } = require('../models/agent');

// Resolve a Bearer token to its (non-revoked) Agent, or null. Every failure
// collapses to null so a probing caller learns nothing about which part was
// wrong.
async function authenticateAgent(req) {
	const auth = req.headers['authorization'] || '';
	const m = /^Bearer\s+(.+)$/i.exec(auth);
	if (!m) return null;
	const token = String(m[1]).trim();
	if (!token) return null;
	try {
		const agent = await Agent.authenticate(token);
		return agent || null;
	} catch (_) {
		return null;
	}
}

module.exports = { authenticateAgent };
