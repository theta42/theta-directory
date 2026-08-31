'use strict';

// Enrolling and addressing client devices.
//
// A device gets an address from its own site's pool (10.<siteId>.128.0/17), so
// it is reachable from anywhere in the cluster without any extra routing: every
// gateway already routes 10.<n>.0.0/16 to site n. The address is fixed for the
// life of the row, because it is what other people's firewall rules and DNS
// entries end up pointing at.

const crypto = require('crypto');
const { MeshClient, MeshExitGrant } = require('../models/mesh_client');
const { withLock } = require('./mutex');
const { clientIp, assertSiteId } = require('./mesh_addressing');
const wgKeys = require('./wg_keys');

const now = () => Math.floor(Date.now() / 1000);

// Enough addresses that exhaustion is a bug, not a capacity limit: a /17 with
// .0 and .255 skipped in each /24 is 32512 devices per site.
const MAX_CLIENT_INDEX = 128 * 254;

/**
 * Lowest free address in a site's client pool.
 *
 * Lowest-free rather than a counter so that removing a device returns its
 * address to the pool -- a counter would march upward forever and eventually
 * exhaust a pool that is mostly empty.
 */
async function nextFreeIp(siteId) {
	assertSiteId(siteId);
	const taken = new Set((await MeshClient.list({ where: { siteId: Number(siteId) } })).map((c) => c.assignedIp));
	for (let i = 1; i <= MAX_CLIENT_INDEX; i++) {
		const ip = clientIp(siteId, i);
		if (!taken.has(ip)) return ip;
	}
	throw Object.assign(new Error(`client address pool exhausted for site ${siteId}`), { status: 507 });
}

/**
 * Enrol a device.
 *
 * The keypair is the caller's choice. Supply `publicKey` and the private key
 * never exists here at all (what theta-agent does -- it generates locally).
 * Omit it and one is generated, returned to the caller EXACTLY ONCE, and not
 * stored; `privateKey` on the result is the only time it exists outside the
 * device, which is why callers must render it into a config or QR immediately
 * and never persist it.
 *
 * Allocation is serialized: picking the lowest free address is a
 * read-then-write, and two devices enrolling at the same moment would
 * otherwise both be handed the same one. That is the same failure the spoke
 * ServerID allocator hit for real (routes/api_site.js), where it silently
 * broke replication rather than erroring.
 */
async function enroll({ uid, name, siteId, publicKey, source, agentId }) {
	if (!uid) throw Object.assign(new Error('uid is required'), { status: 400 });
	if (!name) throw Object.assign(new Error('a device name is required'), { status: 400 });
	assertSiteId(siteId);

	let privateKey = null;
	let pub = String(publicKey || '').trim();
	if (!pub) {
		const kp = wgKeys.generateKeypair();
		pub = kp.publicKey;
		privateKey = kp.privateKey;
	} else if (!/^[A-Za-z0-9+/]{42}[A-Za-z0-9+/=]{2}$/.test(pub)) {
		// A WireGuard key is 32 raw bytes in base64: 44 chars. Rejecting a
		// malformed one here beats writing a row whose peer entry `wg` will
		// refuse later, on a gateway, where nobody is watching.
		throw Object.assign(new Error('publicKey is not a valid WireGuard public key'), { status: 400 });
	}

	const client = await withLock('mesh-client-enroll', async () => {
		const clash = (await MeshClient.list({ where: { publicKey: pub } }))[0];
		if (clash) throw Object.assign(new Error('that public key is already enrolled'), { status: 409 });
		return MeshClient.create({
			id: crypto.randomUUID(),
			uid, name,
			siteId: Number(siteId),
			assignedIp: await nextFreeIp(siteId),
			publicKey: pub,
			exitSiteId: null,
			source: source || (privateKey ? 'manual' : 'agent'),
			agentId: agentId || null,
			createdAt: now(),
			lastSeenAt: 0
		});
	}, { label: `mesh client enroll: ${uid}/${name}` });

	// privateKey rides along on the RESULT only; it was never written.
	notifyReplication('mesh-client-enrolled');
	return { client, privateKey };
}

function notifyReplication(reason) {
	try {
		const { replicateToSpokes } = require('./site_replicate');
		replicateToSpokes(reason);
	} catch (_) {}
}

/** Devices owned by one user. */
async function listForUser(uid) {
	return (await MeshClient.list({ where: { uid } })).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}

/**
 * Which exits this user may choose, as a set of site ids.
 *
 * Every site that offers an exit is usable by every user. This used to be the
 * intersection of "site is willing" (MeshSite.exitOpen) and "admin granted this
 * user that site" (MeshExitGrant) -- two gates, both closed by default, which
 * meant a stock deployment had no usable exit anywhere and no indication why.
 *
 * MeshExitGrant is still written and still honoured as an ADDITIONAL grant, so
 * an exit can be handed to a specific user without opening the site to
 * everyone, and so existing grants keep working. It is no longer required.
 */
async function allowedExits(uid) {
	const { MeshSite } = require('../models/mesh_site');
	const open = (await MeshSite.list({ where: { exitOpen: true } })).map((s) => Number(s.siteId));
	const grants = await MeshExitGrant.list({ where: { uid } });
	return new Set([...open, ...grants.map((g) => Number(g.siteId))]);
}

/**
 * Point a device at an exit (or at null for local breakout).
 *
 * Checked against allowedExits(), which is now "any site offering an exit,
 * plus anything explicitly granted to this user".
 */
async function setExit(client, exitSiteId, { actorUid, isAdmin } = {}) {
	if (exitSiteId === null || exitSiteId === undefined || exitSiteId === '') {
		await client.update({ exitSiteId: null });
		notifyReplication('mesh-client-exit-changed');
		return client;
	}
	const target = Number(exitSiteId);
	assertSiteId(target);
	if (!isAdmin) {
		const allowed = await allowedExits(client.uid);
		if (!allowed.has(target)) {
			throw Object.assign(new Error(`${client.uid} is not permitted to use site ${target} as an exit`), { status: 403 });
		}
	}
	await client.update({ exitSiteId: target });
	if (actorUid) client._lastActor = actorUid;
	notifyReplication('mesh-client-exit-changed');
	return client;
}

async function grantExit(uid, siteId, grantedBy) {
	assertSiteId(siteId);
	const existing = (await MeshExitGrant.list({ where: { uid, siteId: Number(siteId) } }))[0];
	if (existing) return existing;
	const grant = await MeshExitGrant.create({
		id: crypto.randomUUID(), uid, siteId: Number(siteId), grantedBy: grantedBy || '', createdAt: now()
	});
	notifyReplication('mesh-exit-grant-changed');
	return grant;
}

async function revokeExit(uid, siteId) {
	const existing = (await MeshExitGrant.list({ where: { uid, siteId: Number(siteId) } }))[0];
	if (!existing) return false;
	// Any device already pointed at the revoked exit falls back to local
	// breakout rather than keeping a route the user may no longer use.
	for (const client of await MeshClient.list({ where: { uid, exitSiteId: Number(siteId) } })) {
		await client.update({ exitSiteId: null });
	}
	await existing.delete();
	notifyReplication('mesh-exit-grant-revoked');
	return true;
}


/**
 * Re-render a device's peer config and push it down its agent's WSS channel.
 *
 * Needed whenever a device's exit changes. Switching between two exits leaves
 * the client config alone -- AllowedIPs is 0.0.0.0/0 either way and the gateway
 * reroutes -- but crossing the local-breakout boundary flips AllowedIPs between
 * `0.0.0.0/0` and the split-tunnel pair, so the device genuinely needs the new
 * config. Pushing unconditionally for agent-backed devices is simpler than
 * reasoning about which transition just happened, and is a no-op on the wire
 * when the config is identical.
 *
 * Best-effort by design: the selection is already persisted and the gateway
 * converges on its own reconcile, so a disconnected agent must not fail the
 * request. Returns whether the push actually went out.
 */
async function pushConfigToAgent(client) {
	if (!client || !client.agentId) return false;
	try {
		const roster = require('./mesh_roster');
		const { renderClientConf } = require('./mesh_client_conf');
		const { Agent } = require('../models/agent');
		const agentManager = require('./agent_manager');

		const site = await roster.bySiteId(client.siteId);
		if (!site || !site.gatewayPublicKey) return false;
		const agent = (await Agent.list({ where: { id: client.agentId } }))[0];
		if (!agent) return false;

		// privateKey null: the agent fills in the key it generated at enrolment.
		//
		// siteId/exitSiteId ride along because they are what the agent's
		// auto-VPN reads to decide whether the tunnel should be UP right now
		// (theta-agent home_detect.go). Sending them with the config means the
		// agent never has to make that call on a cached answer -- and lets a
		// config be delivered ahead of the moment it is needed, rather than
		// forcing the tunnel up the instant it arrives.
		await agentManager.sendCommand(agent, 'wireguard_apply', {
			config: renderClientConf({ client, site, privateKey: null }),
			siteId: Number(client.siteId),
			exitSiteId: client.exitSiteId === null || client.exitSiteId === undefined
				? null : Number(client.exitSiteId)
		}, true);
		return true;
	} catch (e) {
		console.warn(`[mesh] could not push config to the agent for ${client.name}: ${e.message}`);
		return false;
	}
}

/**
 * Adopt client devices and exit grants carried in a master export.
 *
 * This allows spoke gateways to learn which devices across the cluster
 * exit through this site, and which exit grants exist.
 */
async function adoptClients(meshClients = [], meshExitGrants = []) {
	let adoptedClients = 0;
	let adoptedGrants = 0;

	if (Array.isArray(meshClients) && meshClients.length) {
		const existingClients = await MeshClient.list();
		const byId = new Map(existingClients.map((c) => [c.id, c]));
		const byKey = new Map(existingClients.map((c) => [c.publicKey, c]));

		for (const row of meshClients) {
			if (!row.publicKey || !row.assignedIp) continue;
			const siteId = Number(row.siteId);
			if (!siteId) continue;

			const fields = {
				uid: row.uid || '',
				name: row.name || '',
				siteId,
				assignedIp: row.assignedIp,
				publicKey: row.publicKey,
				exitSiteId: row.exitSiteId === null || row.exitSiteId === undefined || row.exitSiteId === '' ? null : Number(row.exitSiteId),
				source: row.source || 'manual',
				agentId: row.agentId || null,
				createdAt: Number(row.createdAt || 0),
				lastSeenAt: Number(row.lastSeenAt || 0)
			};

			const match = (row.id && byId.get(row.id)) || byKey.get(row.publicKey);
			if (match) {
				await match.update(fields);
			} else {
				await MeshClient.create({
					id: row.id || crypto.randomUUID(),
					...fields
				});
			}
			adoptedClients++;
		}
	}

	if (Array.isArray(meshExitGrants) && meshExitGrants.length) {
		const existingGrants = await MeshExitGrant.list();
		const byKey = new Map(existingGrants.map((g) => [`${g.uid}|${g.siteId}`, g]));

		for (const row of meshExitGrants) {
			if (!row.uid || !row.siteId) continue;
			const siteId = Number(row.siteId);
			const key = `${row.uid}|${siteId}`;
			const fields = {
				uid: row.uid,
				siteId,
				grantedBy: row.grantedBy || '',
				createdAt: Number(row.createdAt || 0)
			};

			const match = byKey.get(key);
			if (match) {
				await match.update(fields);
			} else {
				await MeshExitGrant.create({
					id: row.id || crypto.randomUUID(),
					...fields
				});
			}
			adoptedGrants++;
		}
	}

	return { adopted: adoptedClients, grants: adoptedGrants };
}

module.exports = {
	nextFreeIp, enroll, listForUser, allowedExits, setExit, grantExit, revokeExit,
	pushConfigToAgent, adoptClients, MAX_CLIENT_INDEX
};
