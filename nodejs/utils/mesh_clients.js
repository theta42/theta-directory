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
	return { client, privateKey };
}

/** Devices owned by one user. */
async function listForUser(uid) {
	return (await MeshClient.list({ where: { uid } })).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
}

/** Which exits this user has been granted, as a set of site ids. */
async function allowedExits(uid) {
	const grants = await MeshExitGrant.list({ where: { uid } });
	return new Set(grants.map((g) => Number(g.siteId)));
}

/**
 * Point a device at an exit (or at null for local breakout).
 *
 * Checked against the user's grants, not against whether the site merely
 * offers an exit: `exitOpen` means a site is WILLING to carry traffic, never
 * that anyone may use it. An admin picks who gets what.
 */
async function setExit(client, exitSiteId, { actorUid, isAdmin } = {}) {
	if (exitSiteId === null || exitSiteId === undefined || exitSiteId === '') {
		await client.update({ exitSiteId: null });
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
	return client;
}

async function grantExit(uid, siteId, grantedBy) {
	assertSiteId(siteId);
	const existing = (await MeshExitGrant.list({ where: { uid, siteId: Number(siteId) } }))[0];
	if (existing) return existing;
	return MeshExitGrant.create({
		id: crypto.randomUUID(), uid, siteId: Number(siteId), grantedBy: grantedBy || '', createdAt: now()
	});
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
	return true;
}

module.exports = {
	nextFreeIp, enroll, listForUser, allowedExits, setExit, grantExit, revokeExit, MAX_CLIENT_INDEX
};
