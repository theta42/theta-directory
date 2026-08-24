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

// POST /mesh/enroll — an agent registers its own WireGuard identity.
//
//   { publicKey: "<44-char base64>" }
//   -> { status: "ok", client: { id, name, assignedIp, siteId, exitSiteId } }
//
// Until this existed the agent had no mesh identity at all: the only thing that
// created a MeshClient was an admin POSTing /api/mesh/clients by hand, so a
// freshly installed agent never appeared under jump-host's mesh view. Worse,
// the push path assumed the agent already held a keypair -- renderClientConf()
// emits `PrivateKey = <generated on this device>` for an agent-owned device --
// but nothing ever generated one, so a pushed config could not come up.
//
// The agent generates its keypair locally and sends only the public half; the
// private key never leaves the host, which is what lets the Directory keep its
// promise not to store client private keys.
//
// Idempotent by agentId: an agent that reconnects, or one whose key file was
// replaced, converges onto a single device row rather than accumulating one per
// restart and exhausting the site's address pool.
const { MeshClient } = require('../models/mesh_client');
const meshClients = require('../utils/mesh_clients');
const meshRoster = require('../utils/mesh_roster');

router.post('/mesh/enroll', async (req, res, next) => {
	try {
		const agent = await authenticateAgent(req);
		if (!agent) return res.status(401).json({ status: 'error', message: 'unauthorized' });

		const publicKey = String((req.body || {}).publicKey || '').trim();
		if (!publicKey) {
			return res.status(400).json({ status: 'error', message: 'publicKey is required' });
		}

		const siteId = meshRoster.localSiteId();
		if (!siteId) {
			return res.status(409).json({ status: 'error', message: 'this node has no site id yet' });
		}

		// The device belongs to whoever enrolled the agent, so it lands in a
		// real user's device list. Agents enrolled by a join key with no
		// recorded actor fall back to the agent's own id, which is still a
		// stable owner key -- better than dropping the row entirely.
		const uid = agent.enrolled_by || `agent:${agent.id}`;
		const name = agent.name || `agent-${String(agent.id).slice(0, 8)}`;

		const existing = (await MeshClient.list({ where: { agentId: agent.id } }))[0];
		if (existing) {
			const patch = {};
			if (existing.publicKey !== publicKey) patch.publicKey = publicKey;
			if (Object.keys(patch).length) await existing.update(patch);
			return res.json({
				status: 'ok',
				rotated: !!patch.publicKey,
				client: {
					id: existing.id, name: existing.name, assignedIp: existing.assignedIp,
					siteId: Number(existing.siteId),
					exitSiteId: existing.exitSiteId === null || existing.exitSiteId === undefined
						? null : Number(existing.exitSiteId)
				}
			});
		}

		const { client } = await meshClients.enroll({
			uid, name, siteId, publicKey, source: 'agent', agentId: agent.id
		});
		res.status(201).json({
			status: 'ok',
			client: {
				id: client.id, name: client.name, assignedIp: client.assignedIp,
				siteId: Number(client.siteId),
				exitSiteId: client.exitSiteId === null || client.exitSiteId === undefined
					? null : Number(client.exitSiteId)
			}
		});
	} catch (err) {
		if (err && err.status) {
			return res.status(err.status).json({ status: 'error', message: err.message });
		}
		next(err);
	}
});

// ── Mesh exit selection, from the device itself ─────────────────────────────
//
// The Directory has always computed `allowedExits` "so the UI and the agent
// tray render the same set" (routes/api_mesh.js), but the tray half was never
// built and there was no agent-facing way to read or change it -- the only
// endpoints were session-authenticated and keyed on a browser user. These two
// close that gap.


// Resolve the caller's own device row. Everything below acts on this one row
// and nothing else, so an agent can never read or steer another host.
async function deviceForAgent(agent) {
	return (await MeshClient.list({ where: { agentId: agent.id } }))[0] || null;
}

// GET /mesh/exits — the exits this device may choose, and the one it is on.
router.get('/mesh/exits', async (req, res, next) => {
	try {
		const agent = await authenticateAgent(req);
		if (!agent) return res.status(401).json({ status: 'error', message: 'unauthorized' });

		const device = await deviceForAgent(agent);
		if (!device) {
			return res.status(409).json({ status: 'error', message: 'this agent has no mesh device yet' });
		}

		const allowed = await meshClients.allowedExits(device.uid);
		const roster = await meshRoster.roster();
		const exits = roster
			.filter((s) => allowed.has(Number(s.siteId)))
			.map((s) => ({
				siteId: Number(s.siteId),
				name: s.name || s.slug || `site ${s.siteId}`,
				country: s.country || '',
				city: s.city || '',
				// The device's own site is a valid pick, but it means "no exit"
				// in practice -- flagged so the tray can say so.
				isLocal: Number(s.siteId) === Number(device.siteId)
			}))
			.sort((a, b) => a.name.localeCompare(b.name));

		res.json({
			status: 'ok',
			current: device.exitSiteId === null || device.exitSiteId === undefined
				? null : Number(device.exitSiteId),
			exits
		});
	} catch (err) {
		if (err && err.status) return res.status(err.status).json({ status: 'error', message: err.message });
		next(err);
	}
});

// PUT /mesh/exit — route this device through an exit, or null for local
// breakout. On success the new peer config is pushed straight back down the
// agent's own WSS channel, so the change takes effect without anyone visiting
// the web UI.
router.put('/mesh/exit', async (req, res, next) => {
	try {
		const agent = await authenticateAgent(req);
		if (!agent) return res.status(401).json({ status: 'error', message: 'unauthorized' });

		const device = await deviceForAgent(agent);
		if (!device) {
			return res.status(409).json({ status: 'error', message: 'this agent has no mesh device yet' });
		}

		const raw = (req.body || {}).siteId;
		const siteId = raw === null || raw === undefined || raw === '' ? null : Number(raw);

		// setExit enforces allowedExits -- deliberately NOT with isAdmin, so a
		// compromised agent token cannot route itself through a site its owner
		// may not use.
		await meshClients.setExit(device, siteId, { actorUid: device.uid });

		// Same push the web UI performs, so both paths behave identically.
		const pushed = await meshClients.pushConfigToAgent(device);

		res.json({ status: 'ok', current: siteId, pushed });
	} catch (err) {
		if (err && err.status) return res.status(err.status).json({ status: 'error', message: err.message });
		next(err);
	}
});
