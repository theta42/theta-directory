'use strict';

// The WireGuard cluster's control API. Three audiences, three auth levels:
//
//   GATEWAYS  pull the roster and publish facts about THEIR OWN site. A
//             gateway authenticates with an API token, and can only ever write
//             its own row -- so no site can rewrite another site's network
//             config, and a partition cannot corrupt anyone.
//   ADMINS    designate the hub, configure a site's LAN/DNS/exit settings, and
//             decide which users may use which exits.
//   USERS     enrol and manage their OWN devices, and pick an exit from the
//             set an admin granted them.
//
// The directory never invents WireGuard configuration. It allocates the one
// cluster-unique number (siteId, which IS the site's LDAP ServerID), stores
// what each gateway asserts about itself, and distributes it. See
// utils/mesh_roster.js.

const express = require('express');
const middleware = require('../middleware/auth');
const permission = require('../utils/permission');
const { MeshSite } = require('../models/mesh_site');
const { MeshClient, MeshExitGrant } = require('../models/mesh_client');
const roster = require('../utils/mesh_roster');
const clients = require('../utils/mesh_clients');
const meshAddressing = require('../utils/mesh_addressing');
const { renderClientConf, clientRoutes } = require('../utils/mesh_client_conf');

const router = express.Router();
const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

// Same structured-line convention as routes/api_site.js. Never include a key,
// a config, or anything else that would put a credential in the log.
function logAudit(action, details) {
	console.log(JSON.stringify({ timestamp: new Date().toISOString(), component: 'mesh', action, ...details }));
}

async function isAdmin(user) {
	try {
		await permission.byGroup(user, ADMIN_GROUPS);
		return true;
	} catch (e) {
		return false;
	}
}

function requireAdmin(req, res, next) {
	isAdmin(req.user).then((ok) => {
		if (ok) return next();
		res.status(403).json({ status: 'error', message: 'admin only' });
	}).catch(next);
}

// ── Roster ──────────────────────────────────────────────────────────────────

// What every gateway pulls. Any authenticated caller may read it: it is public
// keys, endpoints and subnets -- the things peers must know about each other
// to talk at all. Nothing here is a credential.
router.get('/roster', middleware.auth, async (req, res, next) => {
	try {
		// Pick up sites that have joined the directory but whose gateway has
		// not published yet, so a freshly-joined site is visible (and
		// configurable) before anyone starts its gateway.
		await roster.syncFromSpokes().catch(() => ({ created: 0 }));
		const sites = await roster.roster();
		const hub = sites.find((s) => s.isHub) || null;
		res.json({
			status: 'ok',
			localSiteId: roster.localSiteId(),
			hubSiteId: hub ? hub.siteId : null,
			sites: sites.map((s) => s.toPublic()),
			addressing: {
				maxSiteId: meshAddressing.MAX_SITE_ID,
				softLimit: meshAddressing.SOFT_SITE_LIMIT,
				shadowSlots: meshAddressing.SHADOW_SLOTS
			}
		});
	} catch (e) { next(e); }
});

// A gateway publishing facts about its own site. It cannot name a site: the
// row it writes is decided by which node it is talking to (localSiteId), so a
// compromised or confused gateway cannot rewrite another site's config.
router.put('/self', middleware.auth, async (req, res, next) => {
	try {
		const { gatewayPublicKey, gatewayEndpoint, gatewayExitPublicKey, exitOpen, country, city, lan168, lan172, dnsHost, name, slug } = req.body || {};
		const site = await roster.publishLocalSite({
			gatewayPublicKey, gatewayEndpoint, gatewayExitPublicKey, exitOpen, country, city, lan168, lan172, dnsHost, name, slug
		});
		res.json({ status: 'ok', site: site.toPublic() });
	} catch (e) { next(e); }
});

// The peers a gateway should build, already resolved: who is the hub, which
// sites are directly reachable, and what each one's AllowedIPs are. Computing
// it here keeps the addressing rules in one place rather than reimplemented on
// every gateway.
router.get('/peers', middleware.auth, async (req, res, next) => {
	try {
		const localId = roster.localSiteId();
		const sites = await roster.roster();
		const hub = sites.find((s) => s.isHub) || null;

		const peers = sites
			.filter((s) => Number(s.siteId) !== Number(localId))
			.filter((s) => s.gatewayPublicKey)
			.map((s) => ({
				siteId: s.siteId,
				slug: s.slug,
				publicKey: s.gatewayPublicKey,
				endpoint: s.gatewayEndpoint || '',
				isHub: !!s.isHub,
				// The hub carries the whole mesh as a catch-all so sites that
				// are not directly peered still reach each other. Longest-prefix
				// match means a direct peer's /16 wins automatically.
				allowedIps: s.isHub
					? [...meshAddressing.hubAllowedIps(), ...meshAddressing.peerAllowedIps(s.siteId)]
					: meshAddressing.peerAllowedIps(s.siteId)
			}));

		// Gateways that route internet traffic OUT through this site. They dial
		// this gateway's mesh interface with their EXIT key, so it needs a peer
		// entry for that key -- otherwise the handshake is refused and the exit
		// silently does not work at the far end.
		//
		// Each is allowed only the specific device addresses actually using
		// this exit, not the whole originating site: an exit is permission to
		// send internet traffic, not a route into someone's network.
		const exitPeers = [];
		if (localId) {
			const exiting = await MeshClient.list({ where: { exitSiteId: Number(localId) } });
			const bySite = new Map();
			for (const client of exiting) {
				const homeId = Number(client.siteId);
				if (homeId === Number(localId)) continue; // local breakout, no tunnel
				if (!bySite.has(homeId)) bySite.set(homeId, []);
				bySite.get(homeId).push(`${client.assignedIp}/32`);
			}
			for (const [homeId, allowedIps] of bySite) {
				const home = sites.find((s) => Number(s.siteId) === homeId);
				if (!home || !home.gatewayExitPublicKey) continue;
				exitPeers.push({ siteId: homeId, slug: home.slug, publicKey: home.gatewayExitPublicKey, allowedIps });
			}
		}

		res.json({
			status: 'ok',
			localSiteId: localId,
			hubSiteId: hub ? hub.siteId : null,
			exitPeers,
			meshAddress: localId ? meshAddressing.meshAddress(localId) : null,
			siteCidr: localId ? meshAddressing.siteCidr(localId) : null,
			gatewayIp: localId ? meshAddressing.siteGatewayIp(localId) : null,
			peers
		});
	} catch (e) { next(e); }
});

// Every client this gateway is responsible for, with the exit each one should
// be policy-routed to. This is what the gateway turns into wg peer entries and
// `ip rule` lines.
router.get('/site-clients', middleware.auth, async (req, res, next) => {
	try {
		const localId = roster.localSiteId();
		if (!localId) return res.json({ status: 'ok', localSiteId: null, clients: [] });
		const rows = await MeshClient.list({ where: { siteId: Number(localId) } });
		res.json({
			status: 'ok',
			localSiteId: localId,
			clients: rows.map((c) => ({
				id: c.id, uid: c.uid, name: c.name,
				publicKey: c.publicKey, assignedIp: c.assignedIp,
				exitSiteId: c.exitSiteId === null || c.exitSiteId === undefined ? null : Number(c.exitSiteId)
			}))
		});
	} catch (e) { next(e); }
});

// ── Admin: site settings and hub ────────────────────────────────────────────

router.put('/sites/:siteId', middleware.auth, requireAdmin, async (req, res, next) => {
	try {
		const site = await roster.bySiteId(req.params.siteId);
		if (!site) return res.status(404).json({ status: 'error', message: 'no such site' });
		const patch = {};
		for (const key of ['name', 'slug', 'exitOpen', 'country', 'city', 'lan168', 'lan172', 'dnsHost']) {
			if (req.body[key] !== undefined) patch[key] = req.body[key];
		}
		await site.update(patch);
		// Every site's gateway needs this, not just ours -- push it out rather
		// than waiting for an unrelated catalog change to carry it.
		require('../utils/site_replicate').replicateToSpokes('mesh-roster-changed');
		logAudit('mesh_site_updated', { actor: req.user.uid, siteId: site.siteId, fields: Object.keys(patch) });
		res.json({ status: 'ok', site: site.toPublic() });
	} catch (e) { next(e); }
});

// Exactly one hub, because two sites both claiming 10.0.0.0/8 would each be a
// catch-all for traffic the other expects to carry.
router.put('/hub/:siteId', middleware.auth, requireAdmin, async (req, res, next) => {
	try {
		const site = await roster.setHub(req.params.siteId);
		// The hub carries the whole mesh as a catch-all, so a change here
		// alters what every other gateway routes through.
		require('../utils/site_replicate').replicateToSpokes('mesh-roster-changed');
		logAudit('mesh_hub_set', { actor: req.user.uid, siteId: site.siteId });
		res.json({ status: 'ok', site: site.toPublic() });
	} catch (e) { next(e); }
});

// ── Admin: who may use which exit ───────────────────────────────────────────

router.get('/exit-grants', middleware.auth, requireAdmin, async (req, res, next) => {
	try {
		const where = req.query.uid ? { uid: req.query.uid } : undefined;
		res.json({ status: 'ok', grants: await MeshExitGrant.list(where ? { where } : undefined) });
	} catch (e) { next(e); }
});

router.post('/exit-grants', middleware.auth, requireAdmin, async (req, res, next) => {
	try {
		const { uid, siteId } = req.body || {};
		if (!uid || siteId === undefined) {
			return res.status(400).json({ status: 'error', message: 'uid and siteId are required' });
		}
		const site = await roster.bySiteId(siteId);
		if (!site) return res.status(404).json({ status: 'error', message: 'no such site' });
		// A site that does not offer an exit cannot be granted as one -- the
		// grant would produce a routing rule pointing at a gateway that never
		// agreed to carry the traffic.
		if (!site.exitOpen) {
			return res.status(409).json({ status: 'error', message: `site ${site.siteId} does not offer an exit` });
		}
		const grant = await clients.grantExit(uid, Number(siteId), req.user.uid);
		logAudit('mesh_exit_granted', { actor: req.user.uid, uid, siteId: Number(siteId) });
		res.status(201).json({ status: 'ok', grant });
	} catch (e) { next(e); }
});

router.delete('/exit-grants/:uid/:siteId', middleware.auth, requireAdmin, async (req, res, next) => {
	try {
		const removed = await clients.revokeExit(req.params.uid, Number(req.params.siteId));
		if (!removed) return res.status(404).json({ status: 'error', message: 'no such grant' });
		logAudit('mesh_exit_revoked', { actor: req.user.uid, uid: req.params.uid, siteId: Number(req.params.siteId) });
		res.json({ status: 'ok' });
	} catch (e) { next(e); }
});

// ── Devices ─────────────────────────────────────────────────────────────────

// A user sees their own devices; an admin can look at anyone's.
router.get('/clients', middleware.auth, async (req, res, next) => {
	try {
		const wantUid = req.query.uid && req.query.uid !== req.user.uid ? req.query.uid : req.user.uid;
		if (wantUid !== req.user.uid && !(await isAdmin(req.user))) {
			return res.status(403).json({ status: 'error', message: 'admin only' });
		}
		const rows = await clients.listForUser(wantUid);
		const allowed = await clients.allowedExits(wantUid);
		res.json({
			status: 'ok',
			clients: rows,
			// The exits this user may choose from, so the UI and the agent tray
			// render the same set without each deriving the rule themselves.
			allowedExits: [...allowed]
		});
	} catch (e) { next(e); }
});

// Enrol a device. The private key is returned EXACTLY ONCE and never stored --
// or omitted entirely when the device generated its own keypair and sent up
// only the public half (what theta-agent does).
router.post('/clients', middleware.auth, async (req, res, next) => {
	try {
		const { name, publicKey, uid: forUid, siteId } = req.body || {};
		const uid = forUid && forUid !== req.user.uid ? forUid : req.user.uid;
		if (uid !== req.user.uid && !(await isAdmin(req.user))) {
			return res.status(403).json({ status: 'error', message: 'admin only' });
		}

		const targetSite = siteId !== undefined ? Number(siteId) : roster.localSiteId();
		if (!targetSite) {
			return res.status(409).json({ status: 'error', message: 'this node has no site id yet' });
		}
		const site = await roster.bySiteId(targetSite);
		if (!site) return res.status(404).json({ status: 'error', message: 'no such site' });
		if (!site.gatewayPublicKey) {
			return res.status(409).json({
				status: 'error',
				message: `site ${targetSite}'s gateway has not published its WireGuard identity yet`
			});
		}

		const { client, privateKey } = await clients.enroll({ uid, name, siteId: targetSite, publicKey, agentId: req.body.agentId });
		logAudit('mesh_client_enrolled', { actor: req.user.uid, uid, name, siteId: targetSite, ip: client.assignedIp });

		res.status(201).json({
			status: 'ok',
			client,
			// Shown once. Not stored, not recoverable, not logged.
			conf: renderClientConf({ client, site, privateKey }),
			routes: clientRoutes({ client, site }),
			privateKeyIssued: !!privateKey
		});
	} catch (e) { next(e); }
});

// Push a device's config to the machine over its theta-agent websocket, so a
// laptop configures itself instead of a human copying a file around.
//
// This only works for a device whose key the agent generated locally: the
// server does not keep private keys, so a config generated here cannot be
// re-rendered later. That is the intended trade -- the push carries a config
// the agent completes with the key it already holds.
router.post('/clients/:id/push', middleware.auth, async (req, res, next) => {
	try {
		const client = (await MeshClient.list({ where: { id: req.params.id } }))[0];
		if (!client) return res.status(404).json({ status: 'error', message: 'no such device' });
		if (client.uid !== req.user.uid && !(await isAdmin(req.user))) {
			return res.status(403).json({ status: 'error', message: 'not your device' });
		}
		if (!client.agentId) {
			return res.status(409).json({ status: 'error', message: 'this device does not run theta-agent' });
		}
		const site = await roster.bySiteId(client.siteId);
		if (!site || !site.gatewayPublicKey) {
			return res.status(409).json({ status: 'error', message: 'this site\'s gateway has not published its identity yet' });
		}

		const { Agent } = require('../models/agent');
		const agent = (await Agent.list({ where: { id: client.agentId } }))[0];
		if (!agent) return res.status(404).json({ status: 'error', message: 'the agent for this device no longer exists' });

		const agentManager = require('../utils/agent_manager');
		// privateKey is null: the agent holds its own and fills in the
		// placeholder. wireguard_apply is signed and gated on the agent's
		// `wireguard` capability at the far end.
		// Only the config. The agent applies it with wg-quick, which installs
		// routes from AllowedIPs itself -- 10.0.0.0/8 + 172.24.0.0/16 for a
		// split-tunnel device, 0.0.0.0/0 for one using an exit. Sending a
		// separate route list would imply the agent acts on it, which it does
		// not; clientRoutes() stays for the enrolment response, where a human
		// setting a device up by hand needs to see them.
		await agentManager.sendCommand(agent, 'wireguard_apply', {
			config: renderClientConf({ client, site, privateKey: null })
		}, true);

		logAudit('mesh_client_pushed', { actor: req.user.uid, client: client.id, agent: agent.id });
		res.json({ status: 'ok' });
	} catch (e) {
		if (/not connected/.test(e.message)) {
			return res.status(409).json({ status: 'error', message: e.message });
		}
		next(e);
	}
});

router.put('/clients/:id/exit', middleware.auth, async (req, res, next) => {
	try {
		const client = (await MeshClient.list({ where: { id: req.params.id } }))[0];
		if (!client) return res.status(404).json({ status: 'error', message: 'no such device' });
		const admin = await isAdmin(req.user);
		if (client.uid !== req.user.uid && !admin) {
			return res.status(403).json({ status: 'error', message: 'not your device' });
		}
		await clients.setExit(client, req.body.exitSiteId, { actorUid: req.user.uid, isAdmin: admin });
		logAudit('mesh_client_exit_set', { actor: req.user.uid, client: client.id, exitSiteId: client.exitSiteId });
		res.json({ status: 'ok', client });
	} catch (e) { next(e); }
});

router.delete('/clients/:id', middleware.auth, async (req, res, next) => {
	try {
		const client = (await MeshClient.list({ where: { id: req.params.id } }))[0];
		if (!client) return res.status(404).json({ status: 'error', message: 'no such device' });
		if (client.uid !== req.user.uid && !(await isAdmin(req.user))) {
			return res.status(403).json({ status: 'error', message: 'not your device' });
		}
		logAudit('mesh_client_removed', { actor: req.user.uid, uid: client.uid, name: client.name, ip: client.assignedIp });
		await client.delete();
		res.json({ status: 'ok' });
	} catch (e) { next(e); }
});

module.exports = router;
