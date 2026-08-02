'use strict';

// Vault broker — mints scoped OpenBao tokens for end users, admins, and
// external apps, using the SSO_VAULT_TOKEN (policy `sso-broker`) and the
// `sso-broker` token role created by theta-env/setup.sh.
//
//   secret/users/<uid>/*   per-user personal KV (user-<uid> policy)
//   secret/apps/<name>/*   per-external-app namespace (app-<name> policy)
//   secret/*               admin UI sessions (sso-admin policy)
//
// The sso-broker policy grants update on auth/token/create/sso-broker and on
// sys/policies/acl/user-*, app-*, sso-admin — exactly what this module needs to
// create the per-subject policies and mint their tokens. Per-user/admin tokens
// are cached in Redis for the token's lifetime and re-minted on miss; per-app
// tokens are returned ONCE (displayed in the UI, never stored retrievably).

const baoConf = require('@simpleworkjs/bao-conf');
const { createClient } = require('redis');
const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const conf = require('@simpleworkjs/conf');
const permission = require('./permission');

const ROLE = 'sso-broker';
const DEFAULT_TTL = 24 * 60 * 60; // matches the role's token_period (24h)

let redisClient;
async function getRedis() {
	if (!redisClient) {
		const url = (conf.redis && typeof conf.redis === 'string') ? conf.redis
			: (conf.redis && conf.redis.url) ? conf.redis.url : undefined;
		redisClient = createClient({ url });
		redisClient.on('error', (err) => console.error('Redis vault_broker error', err));
		await redisClient.connect();
	}
	return redisClient;
}

async function cacheGet(key) {
	try { return await (await getRedis()).get(key); } catch (e) { return null; }
}
async function cacheSet(key, value, ttl) {
	try { await (await getRedis()).set(key, value, { EX: ttl }); } catch (e) { /* best-effort */ }
}

// Low-level OpenBao call via @simpleworkjs/bao-conf.request (authenticates with
// SSO_VAULT_TOKEN). Throws on non-2xx.
async function bao(method, path, body) {
	const res = await baoConf.request(method, path, body);
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`OpenBao ${method} ${path} failed (${res.status}) ${text}`);
	}
	return res;
}

// Ensure an ACL policy exists AND carries the latest HCL. Always (re)writes —
// `bao policy write` is an idempotent overwrite — so policy edits (e.g. adding
// a list grant on a directory path) propagate on the next vault-page visit
// without an operator re-running setup.sh. Skipping on an existing policy
// would strand the old, narrower HCL forever.
async function ensurePolicy(name, hcl) {
	const existing = await baoConf.request('GET', `sys/policies/acl/${name}`);
	if (existing.status !== 200 && existing.status !== 404) {
		const t = await existing.text().catch(() => '');
		throw new Error(`OpenBao policy read ${name} failed (${existing.status}) ${t}`);
	}
	await bao('PUT', `sys/policies/acl/${name}`, { policy: hcl });
}

// Mint a token through the sso-broker role with the given policies. Returns
// { token, ttl } (ttl = lease_duration seconds, falls back to DEFAULT_TTL).
async function mintToken(policies) {
	const res = await bao('POST', 'auth/token/create/sso-broker', { policies });
	const json = await res.json();
	const token = json && json.auth && json.auth.client_token;
	if (!token) throw new Error(`OpenBao token mint returned no client_token: ${JSON.stringify(json)}`);
	const ttl = (json.auth && json.auth.lease_duration) || DEFAULT_TTL;
	return { token, ttl };
}

// ── Per-user token ──────────────────────────────────────────────────────────
function userPolicyHcl(uid) {
	// uid is an LDAP uid (alphanumeric + a few separators); it is interpolated
	// into a policy path, so reject anything but a safe charset.
	// The bare `secret/metadata/users/<uid>` grant is required to LIST the
	// contents of the namespace: `.../*` covers nested paths but NOT the
	// directory itself, so without it the /vault secrets list 403s.
	return `path "secret/data/users/${uid}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/users/${uid}" { capabilities = ["list", "read", "delete"] }
path "secret/metadata/users/${uid}/*" { capabilities = ["list", "read", "delete"] }`;
}

// Mint (or return the cached) per-user token confined to secret/users/<uid>/*.
// Re-minted when the cache entry expires (a little before the token's own TTL).
async function getOrCreateUserToken(uid) {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(uid)) throw new Error(`invalid uid for vault token: ${uid}`);
	const cacheKey = `vault_token:${uid}`;
	const cached = await cacheGet(cacheKey);
	if (cached) return cached;
	await ensurePolicy(`user-${uid}`, userPolicyHcl(uid));
	const { token, ttl } = await mintToken([`user-${uid}`]);
	await cacheSet(cacheKey, token, Math.max(ttl - 60, 60));
	return token;
}

// ── Admin token (read/write all of secret/) ─────────────────────────────────
async function getOrCreateAdminToken(uid) {
	const cacheKey = `vault_token:admin:${uid || 'global'}`;
	const cached = await cacheGet(cacheKey);
	if (cached) return cached;
	const { token, ttl } = await mintToken(['sso-admin']);
	await cacheSet(cacheKey, token, Math.max(ttl - 60, 60));
	return token;
}

// ── Per-app token (minted ONCE, returned to the caller, never cached) ───────
function appPolicyHcl(name) {
	// The bare `secret/metadata/apps/<name>` grant lets an app LIST its own
	// namespace root (see userPolicyHcl for why `/*` alone isn't enough).
	return `path "secret/data/apps/${name}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/apps/${name}" { capabilities = ["list", "read", "delete"] }
path "secret/metadata/apps/${name}/*" { capabilities = ["list", "read", "delete"] }`;
}

// Create the app-<name> policy + mint a token for it. Returns the token ONCE
// (the admin UI shows it with a copy button); it is not stored retrievably, so
// a later compromise of an admin session cannot recover previously-minted app
// tokens. The caller must record it in the external app immediately.
async function mintAppToken(name) {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
		throw new Error('invalid app name (lowercase letters, digits, hyphens; max 63 chars)');
	}
	await ensurePolicy(`app-${name}`, appPolicyHcl(name));
	const { token, ttl } = await mintToken([`app-${name}`]);
	return { token, ttl, policy: `app-${name}`, path: `secret/apps/${name}/` };
}

// ── /api/vault proxy: scope guard + token-injecting proxy ───────────────────
// Replaces the old bare pass-through (which sent no X-Vault-Token and gated
// nothing). The guard mints a server-side token for the user (per-user or
// admin) and enforces the path prefix as defense-in-depth on top of the
// token's own policy; the proxy injects ONLY that token and strips the
// client's sso auth headers so OpenBao never sees them.

const VAULT_ADDR = process.env.VAULT_ADDR || 'http://openbao:8200';
const ADMIN_GROUP = 'app_sso_admin';

async function isAdmin(user) {
	try {
		await permission.byGroup(user, [ADMIN_GROUP]);
		return true;
	} catch (e) {
		return false;
	}
}

// Normalize a KV-v2 request path by stripping the data/metadata segment so the
// prefix check works on the logical path: /secret/data/users/alice/foo ->
// /secret/users/alice/foo. Returns null if the path isn't under /secret/.
function normalizeVaultPath(p) {
	const norm = p.replace(/^\/secret\/(data|metadata)\//, '/secret/');
	if (norm !== '/secret' && !norm.startsWith('/secret/')) return null;
	return norm;
}

async function scopeGuard(req, res, next) {
	if (!req.user || req.user.isMachine) {
		return res.status(403).json({ error: 'machine tokens cannot use the vault API' });
	}
	const uid = req.user.uid;
	const admin = await isAdmin(req.user);
	let token;
	try {
		token = admin ? await getOrCreateAdminToken(uid) : await getOrCreateUserToken(uid);
	} catch (e) {
		return res.status(503).json({ error: 'vault broker unavailable', detail: e.message });
	}

	// Defense-in-depth: confirm the requested path is within the subject's
	// namespace. Admins roam all of secret/; users are confined to
	// secret/users/<uid>/. (The token's own policy enforces the same at the
	// OpenBao layer; this catches a buggy/malicious client early with a clear
	// 403 instead of an opaque OpenBao denial.)
	const norm = normalizeVaultPath(req.path);
	if (norm === null) {
		return res.status(403).json({ error: 'vault paths must be under /secret/' });
	}
	const base = `/secret/users/${uid}`;
	const allowed = admin || norm === base || norm.startsWith(base + '/');
	if (!allowed) {
		return res.status(403).json({ error: 'path outside your vault namespace' });
	}

	req.vaultToken = token;
	req.vaultIsAdmin = admin;
	next();
}

function vaultProxy() {
	return createProxyMiddleware({
		target: VAULT_ADDR,
		changeOrigin: true,
		pathRewrite: { '^/': '/v1/' },
		on: {
			proxyReq(proxyReq, req, res, options) {
				fixRequestBody(proxyReq, req, res, options);
				// Inject ONLY the server-minted scoped token; strip the client's
				// sso session/api auth so it never reaches OpenBao.
				proxyReq.setHeader('X-Vault-Token', req.vaultToken);
				proxyReq.removeHeader('auth-token');
				proxyReq.removeHeader('authorization');
			},
		},
	});
}

// Admin-only: mint a one-time token for an external app. POST /api/vault/apps
// { name } -> { token, ttl, policy, path }. The token is returned ONCE and is
// not cached/stored retrievably. Mount BEFORE the /api/vault proxy.
const mintAppRouter = express.Router();
mintAppRouter.post('/', async (req, res, next) => {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);
		const name = (req.body && req.body.name || '').trim();
		if (!name) return res.status(400).json({ error: 'name is required' });
		const result = await mintAppToken(name);
		res.json(result);
	} catch (e) {
		if (e.status === 401) return res.status(403).json({ error: 'admin only' });
		next(e);
	}
});

module.exports = {
	getOrCreateUserToken,
	getOrCreateAdminToken,
	mintAppToken,
	ensurePolicy,
	scopeGuard,
	vaultProxy,
	mintAppRouter,
};