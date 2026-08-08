'use strict';

// Shared-secrets API.
//
// A shared secret is metadata in the DB (SharedSecret + SharedSecretGrant) with
// its DATA in OpenBao at secret/shared/<ownerUid>/<slug> (KV-v2). The owner has
// full R/W/list on their own secret/shared/<ownerUid>/* subtree; each grantee's
// OpenBao policy content is edited to add read on the exact shared path (see
// vault_broker.js grantSharedSecret/revokeSharedSecret). Enforcement is entirely
// the OpenBao ACL — the broker's policy reconciliation makes a grant effective
// immediately, with no token re-mint.
//
// Reads of the secret DATA are intentionally NOT proxied here: the UI fetches
// them through the existing /api/vault proxy using the requester's own session
// token, so OpenBao ACL enforces read access per-request. This router handles
// metadata CRUD + grant management; KV writes (create/update/delete) are made
// server-side using the acting user's scoped token.

const express = require('express');
const baoConf = require('@simpleworkjs/bao-conf');
const permission = require('../utils/permission');
const { SharedSecret } = require('../models/shared_secret');
const { SharedSecretGrant } = require('../models/shared_secret_grant');
const vaultBroker = require('../utils/vault_broker');

const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];
// Allow hyphens AND underscores (matching the plugin-instance slug convention);
// only reject values that can't be a sane secret path segment (spaces, slashes,
// leading non-alnum, too long).
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const router = express.Router();

// Machine/service tokens cannot manage shared secrets (mirrors scopeGuard on the
// /api/vault proxy — personal, per-user secret management only).
router.use((req, res, next) => {
	if (req.user && req.user.isMachine) {
		return res.status(403).json({ error: 'machine tokens cannot manage shared secrets' });
	}
	next();
});

async function isAdmin(user) {
	try { await permission.byGroup(user, ADMIN_GROUPS); return true; }
	catch (e) { return false; }
}

// Scoped OpenBao token for an actor, used for server-side KV writes. Owner uses
// their own token (R/W on secret/shared/<ownerUid>/*); an admin uses the
// sso-admin token (R/W on secret/*).
async function actorToken(user, ownerUid) {
	if (user.uid === ownerUid) return vaultBroker.getOrCreateUserToken(ownerUid);
	if (await isAdmin(user)) return vaultBroker.getOrCreateAdminToken(user.uid);
	return null;
}

// Does this user manage the given shared secret? Owner or admin.
async function canManage(user, secret) {
	if (user.uid === secret.ownerUid) return true;
	return isAdmin(user);
}

async function loadSecret(req, res) {
	const secret = await SharedSecret.get(req.params.id);
	if (!secret) { res.status(404).json({ error: 'not found' }); return null; }
	return secret;
}

// ── List: mine + shared-with-me ─────────────────────────────────────────────
router.get('/', async (req, res, next) => {
	try {
		const uid = req.user.uid;
		const mine = await SharedSecret.list({ where: { ownerUid: uid } });
		const grants = await SharedSecretGrant.listForGrantee('user', uid);
		const granteeSecretIds = [...new Set(grants.map(g => g.secretId))];
		const granted = granteeSecretIds.length
			? await SharedSecret.list({ where: { id: { in: granteeSecretIds } } }) : [];
		const byId = new Map(mine.map(s => [s.id, { role: 'owner', ...s }]));
		for (const g of granted) {
			if (byId.has(g.id)) continue; // already owner
			byId.set(g.id, { role: 'grantee', ...g });
		}
		// The `{ role, ...s }` spread above copies only own properties, so the
		// instance method `path()` is dropped -- call the static builder instead.
		res.json({ items: [...byId.values()].map(s => ({ id: s.id, slug: s.slug, ownerUid: s.ownerUid, description: s.description, path: SharedSecret.pathFor(s.ownerUid, s.slug), role: s.role })) });
	} catch (e) { next(e); }
});

// ── Create ──────────────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
	try {
		const uid = req.user.uid;
		const slug = String(req.body.slug || '').trim().toLowerCase();
		if (!SLUG_RE.test(slug)) return res.status(400).json({ error: 'slug must be lowercase letters/digits/hyphens/underscores, 1-64 chars' });
		const description = String(req.body.description || '').trim();
		const data = (req.body.data && typeof req.body.data === 'object') ? req.body.data : {};

		if (await SharedSecret.getBySlug(slug)) {
			return res.status(409).json({ error: `a shared secret named '${slug}' already exists` });
		}
		const token = await actorToken(req.user, uid);
		if (!token) return res.status(403).json({ error: 'not allowed' });
		const path = SharedSecret.pathFor(uid, slug);
		await baoConf.set(path, data, { token });

		const secret = await SharedSecret.create({
			slug, ownerUid: uid, description,
			created_by: uid, created_on: Date.now(), updated_by: uid, updated_on: Date.now(),
		});
		res.status(201).json({ id: secret.id, slug, ownerUid: uid, description, path, role: 'owner' });
	} catch (e) { next(e); }
});

// ── Detail (metadata; data is read via /api/vault proxy) ────────────────────
router.get('/:id', async (req, res, next) => {
	try {
		const secret = await loadSecret(req, res);
		if (!secret) return;
		const uid = req.user.uid;
		const admin = await isAdmin(req.user);
		const grantee = (await SharedSecretGrant.listForGrantee('user', uid)).some(g => g.secretId === secret.id);
		if (!admin && uid !== secret.ownerUid && !grantee) return res.status(403).json({ error: 'not shared with you' });
		const grants = await SharedSecretGrant.list({ where: { secretId: secret.id } });
		res.json({ id: secret.id, slug: secret.slug, ownerUid: secret.ownerUid, description: secret.description, path: secret.path(), role: uid === secret.ownerUid ? 'owner' : (admin ? 'admin' : 'grantee'), grants: grants.map(g => ({ id: g.id, granteeType: g.granteeType, granteeId: g.granteeId, capability: g.capability })) });
	} catch (e) { next(e); }
});

// ── Update data / description ───────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
	try {
		const secret = await loadSecret(req, res);
		if (!secret) return;
		if (!(await canManage(req.user, secret))) return res.status(403).json({ error: 'only the owner (or admin) can edit a shared secret' });
		const token = await actorToken(req.user, secret.ownerUid);
		const update = {};
		if (req.body && typeof req.body.data === 'object') {
			await baoConf.set(secret.path(), req.body.data, { token });
		}
		if (req.body && req.body.description !== undefined) {
			update.description = String(req.body.description).trim();
		}
		if (Object.keys(update).length) {
			update.updated_by = req.user.uid;
			update.updated_on = Date.now();
			await secret.update(update);
		}
		res.json({ id: secret.id, slug: secret.slug, ownerUid: secret.ownerUid, description: secret.description, path: secret.path() });
	} catch (e) { next(e); }
});

// ── Delete (KV + DB row + all grants) ───────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
	try {
		const secret = await loadSecret(req, res);
		if (!secret) return;
		if (!(await canManage(req.user, secret))) return res.status(403).json({ error: 'only the owner (or admin) can delete a shared secret' });
		const token = await actorToken(req.user, secret.ownerUid);
		// Revoke all grants first so grantees' policies drop the path.
		const grants = await SharedSecretGrant.list({ where: { secretId: secret.id } });
		for (const g of grants) await vaultBroker.revokeSharedSecret(g.id, req.user.uid);
		// Delete the KV data (metadata delete removes all versions), then the row.
		try { await baoConf.request('DELETE', `secret/metadata/${secret.path()}`, undefined, { token }); } catch (e) { /* best-effort */ }
		await secret.delete();
		res.status(204).end();
	} catch (e) { next(e); }
});

// ── Grants: list ────────────────────────────────────────────────────────────
router.get('/:id/grants', async (req, res, next) => {
	try {
		const secret = await loadSecret(req, res);
		if (!secret) return;
		if (!(await canManage(req.user, secret))) return res.status(403).json({ error: 'only the owner (or admin) can manage grants' });
		const grants = await SharedSecretGrant.list({ where: { secretId: secret.id } });
		res.json({ grants: grants.map(g => ({ id: g.id, granteeType: g.granteeType, granteeId: g.granteeId, capability: g.capability })) });
	} catch (e) { next(e); }
});

// ── Grants: create ──────────────────────────────────────────────────────────
router.post('/:id/grants', async (req, res, next) => {
	try {
		const secret = await loadSecret(req, res);
		if (!secret) return;
		if (!(await canManage(req.user, secret))) return res.status(403).json({ error: 'only the owner (or admin) can manage grants' });
		const granteeType = String(req.body.granteeType || '').trim();
		const granteeId = String(req.body.granteeId || '').trim();
		if (!['user', 'app'].includes(granteeType)) return res.status(400).json({ error: 'granteeType must be user or app' });
		if (!granteeId) return res.status(400).json({ error: 'granteeId is required' });
		if (granteeId === secret.ownerUid && granteeType === 'user') {
			return res.status(400).json({ error: 'the owner already has access' });
		}
		// Idempotent: skip if the grant already exists.
		const existing = (await SharedSecretGrant.list({ where: { secretId: secret.id, granteeType, granteeId } }))[0];
		if (existing) return res.json({ id: existing.id, granteeType, granteeId, capability: existing.capability });
		const grant = await vaultBroker.grantSharedSecret(secret.id, granteeType, granteeId, req.user.uid);
		res.status(201).json({ id: grant.id, granteeType, granteeId, capability: grant.capability });
	} catch (e) { next(e); }
});

// ── Grants: revoke ──────────────────────────────────────────────────────────
router.delete('/:id/grants/:grantId', async (req, res, next) => {
	try {
		const secret = await loadSecret(req, res);
		if (!secret) return;
		if (!(await canManage(req.user, secret))) return res.status(403).json({ error: 'only the owner (or admin) can manage grants' });
		const grant = await SharedSecretGrant.get(req.params.grantId);
		if (!grant || grant.secretId !== secret.id) return res.status(404).json({ error: 'grant not found' });
		await vaultBroker.revokeSharedSecret(grant.id, req.user.uid);
		res.status(204).end();
	} catch (e) { next(e); }
});

module.exports = router;
