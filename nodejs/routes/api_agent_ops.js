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
const { Resource } = require('../models/resource');
const { SharedSecretGrant } = require('../models/shared_secret_grant');
const { SharedSecret } = require('../models/shared_secret');

router.post('/secrets', async (req, res, next) => {
	try {
		const agent = await authenticateAgent(req);
		if (!agent) return res.status(401).json({ status: 'error', message: 'unauthorized' });

		let { paths } = req.body || {};
		let boundResource = null;
		if (agent.resourceId) {
			boundResource = await Resource.get(agent.resourceId).catch(() => null);
		}

		if (!Array.isArray(paths) || paths.length === 0) {
			paths = [`secret/data/nodes/${agent.id}/conf`];
			if (boundResource && boundResource.slug) {
				paths.push(`secret/data/resources/${boundResource.slug}/conf`);
			}
		}

		// Allowed prefixes for this agent:
		// 1. Node scope: secret/data/nodes/<agent.id>/
		// 2. Bound Resource scope: secret/data/resources/<resource.slug>/
		// 3. Shared Resource Grants: secret/data/resources/<grantee-slug>/
		const allowedPrefixes = [`secret/data/nodes/${agent.id}/`];
		if (boundResource && boundResource.slug) {
			allowedPrefixes.push(`secret/data/resources/${boundResource.slug}/`);
		}

		// Add granted shared resources
		if (boundResource) {
			const grants = await SharedSecretGrant.listForGrantee('resource', boundResource.id).catch(() => []);
			for (const g of grants) {
				const sharedSec = await SharedSecret.get(g.secretId).catch(() => null);
				if (sharedSec && sharedSec.slug) {
					allowedPrefixes.push(`secret/data/resources/${sharedSec.slug}/`);
					allowedPrefixes.push(`secret/data/shared/${sharedSec.ownerUid}/${sharedSec.slug}/`);
				}
			}
		}

		const secrets = {};
		for (let p of paths) {
			if (typeof p !== 'string') continue;
			// Normalize human shorthand "resources/foo/bar" -> "secret/data/resources/foo/bar"
			if (p.startsWith('resources/')) {
				p = `secret/data/resources/${p.slice('resources/'.length)}`;
			}

			const isAllowed = allowedPrefixes.some(prefix => p.startsWith(prefix));
			if (!isAllowed) {
				return res.status(403).json({ status: 'error', message: `path outside authorized scope: ${p}` });
			}

			const r = await baoConf.request('GET', p);
			if (r.ok) {
				const body = await r.json().catch(() => ({}));
				const rawMap = (body.data && body.data.data) || {};
				const resolvedMap = {};
				for (const [k, v] of Object.entries(rawMap)) {
					const strV = String(v || '');
					if (strV.startsWith('INHERIT:')) {
						const parts = strV.split(':');
						if (parts.length >= 3) {
							const targetSlug = parts[1];
							const targetKey = parts[2];
							const parentR = await baoConf.request('GET', `secret/data/resources/${targetSlug}/conf`);
							if (parentR.ok) {
								const parentBody = await parentR.json().catch(() => ({}));
								const parentMap = (parentBody.data && parentBody.data.data) || {};
								resolvedMap[k] = parentMap[targetKey] || '';
							} else {
								resolvedMap[k] = '';
							}
						} else {
							resolvedMap[k] = '';
						}
					} else {
						resolvedMap[k] = v;
					}
				}
				secrets[p] = resolvedMap;
			} else {
				secrets[p] = {};
			}
		}

		return res.json({ status: 'ok', secrets });
	} catch (err) { next(err); }
});

module.exports = router;
