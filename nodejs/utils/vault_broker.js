'use strict';

// Vault broker — mints scoped OpenBao tokens for end users, admins, and
// external apps, using the SSO_VAULT_TOKEN (policy `sso-broker`) and the
// `sso-broker` token role created by theta-env/setup.sh.
//
//   secret/users/<uid>/*          per-user personal KV (user-<uid> policy)
//   secret/shared/<uid>/*         user-owned shared KV (user-<uid> policy)
//   secret/apps/<name>/*          per-external-app namespace (app-<name> policy)
//   secret/shared/<owner>/<slug>  granted read (added to grantee's policy)
//   secret/*                      admin UI sessions (sso-admin policy)
//
// The sso-broker policy grants update on auth/token/create/sso-broker and on
// sys/policies/acl/user-*, app-*, sso-admin — exactly what this module needs to
// create the per-subject policies and mint their tokens. Per-user/admin tokens
// are cached in Redis for the token's lifetime and re-minted on miss; per-app
// tokens are returned ONCE (displayed in the UI, never stored retrievably).
//
// Policy reconciliation is the load-bearing part: OpenBao parses policy CONTENT
// live at token use (only the SET of policy names on a token is fixed at mint),
// so we ALWAYS reconcile a subject's policy content BEFORE returning any token
// — cached or freshly minted. That way a stale cached token immediately gains
// corrected/revoked capabilities, and a new shared-secret grant takes effect for
// an existing grantee token with no re-mint. The Redis cache only short-circuits
// token MINTING, never policy reconciliation.

const baoConf = require('@simpleworkjs/bao-conf');
const { createClient } = require('redis');
const express = require('express');
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');
const conf = require('@simpleworkjs/conf');
const permission = require('./permission');
const { SharedSecret } = require('../models/shared_secret');
const { SharedSecretGrant } = require('../models/shared_secret_grant');
const { VaultAppToken } = require('../models/vault_app_token');

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

// Ensure an ACL policy carries exactly `hcl`. Compare-and-skip: read the current
// content and only PUT when it differs. `bao policy write` is an idempotent
// overwrite, so this is safe to call on every token fetch — edits (e.g. adding a
// grant) propagate immediately because OpenBao parses policy content at use.
async function ensurePolicy(name, hcl) {
	const existing = await baoConf.request('GET', `sys/policies/acl/${name}`);
	if (existing.status !== 200 && existing.status !== 404) {
		const t = await existing.text().catch(() => '');
		throw new Error(`OpenBao policy read ${name} failed (${existing.status}) ${t}`);
	}
	if (existing.status === 200) {
		const body = await existing.json().catch(() => null);
		if (body && typeof body.policy === 'string' && body.policy === hcl) return; // unchanged
	}
	await bao('PUT', `sys/policies/acl/${name}`, { policy: hcl });
}

// Mint a token through a token role with the given policies. Returns
// { token, accessor, ttl } (ttl = lease_duration seconds, falls back to
// DEFAULT_TTL). Roles: sso-broker (24h period — user/admin tokens, re-minted
// from cache) and sso-app (768h period — long-lived external-app credentials,
// kept alive via their stored accessor by the renewal loop below).
async function mintToken(policies, role = ROLE) {
	const res = await bao('POST', `auth/token/create/${role}`, { policies });
	const json = await res.json();
	const token = json && json.auth && json.auth.client_token;
	if (!token) throw new Error(`OpenBao token mint returned no client_token: ${JSON.stringify(json)}`);
	const ttl = (json.auth && json.auth.lease_duration) || DEFAULT_TTL;
	return { token, accessor: json.auth.accessor, ttl };
}

// ── Shared-secret policy rules ───────────────────────────────────────────────
// Returns the HCL rules granting `read` on every shared secret the given
// grantee (a user uid or an app name) has been granted. Enforcement is
// OpenBao ACL policy CONTENT — live-evaluated at token use, so these rules take
// effect for the grantee's existing token immediately (no re-mint).
async function sharedPolicyRules(granteeType, granteeId) {
	const grants = await SharedSecretGrant.listForGrantee(granteeType, granteeId);
	if (!grants.length) return '';
	const secretIds = [...new Set(grants.map(g => g.secretId))];
	const secrets = secretIds.length
		? await SharedSecret.list({ where: { id: { in: secretIds } } }) : [];
	const byId = new Map(secrets.map(s => [s.id, s]));
	const rules = [];
	for (const g of grants) {
		const sec = byId.get(g.secretId);
		if (!sec) continue;
		const p = sec.path(); // shared/<ownerUid>/<slug>
		rules.push(`path "secret/data/${p}" { capabilities = ["read"] }`);
		rules.push(`path "secret/metadata/${p}" { capabilities = ["read", "list"] }`);
	}
	return rules.join('\n');
}

// ── Per-user token ──────────────────────────────────────────────────────────
async function userPolicyHcl(uid) {
	const granted = await sharedPolicyRules('user', uid);
	return `path "secret/data/users/${uid}" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/data/users/${uid}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/users/${uid}" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/users/${uid}/" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/users/${uid}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/data/shared/${uid}" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/data/shared/${uid}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/shared/${uid}" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/shared/${uid}/" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/shared/${uid}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
${granted}`.trim();
}

// Mint (or return the cached) per-user token. The policy is ALWAYS reconciled
// (compare-and-skip) before the cache is consulted, so a cached token can never
// outlive a policy change; the cache only short-circuits re-minting. Re-minted
// when the cache entry expires (a little before the token's own TTL).
async function getOrCreateUserToken(uid) {
	if (!/^[A-Za-z0-9._-]{1,64}$/.test(uid)) throw new Error(`invalid uid for vault token: ${uid}`);
	await ensurePolicy(`user-${uid}`, await userPolicyHcl(uid));
	const cacheKey = `vault_token:${uid}`;
	const cached = await cacheGet(cacheKey);
	if (cached) return cached;
	const { token, ttl } = await mintToken([`user-${uid}`]);
	await cacheSet(cacheKey, token, Math.max(ttl - 60, 60));
	return token;
}

// ── Admin token (read/write all of secret/) ─────────────────────────────────
function adminPolicyHcl() {
	return `path "secret/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/data/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/data" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/*" { capabilities = ["create", "read", "update", "delete", "list"] }`;
}

async function getOrCreateAdminToken(uid) {
	await ensurePolicy('sso-admin', adminPolicyHcl());
	const cacheKey = `vault_token:admin:${uid || 'global'}`;
	const cached = await cacheGet(cacheKey);
	if (cached) return cached;
	const { token, ttl } = await mintToken(['sso-admin']);
	await cacheSet(cacheKey, token, Math.max(ttl - 60, 60));
	return token;
}

// ── Per-app token (minted ONCE, returned to the caller, never cached) ───────
async function appPolicyHcl(name) {
	const granted = await sharedPolicyRules('app', name);
	return `path "secret/data/apps/${name}" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/data/apps/${name}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/apps/${name}" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/apps/${name}/" { capabilities = ["create", "read", "update", "delete", "list"] }
path "secret/metadata/apps/${name}/*" { capabilities = ["create", "read", "update", "delete", "list"] }
${granted}`.trim();
}

// Create the app-<name> policy + mint a token for it. Returns the token ONCE
// (the admin UI shows it with a copy button); it is not stored retrievably, so
// a later compromise of an admin session cannot recover previously-minted app
// tokens. The caller must record it in the external app immediately. Later
// grants to the app edit app-<name> policy content (live-applied to this token).
//
// What IS stored is the token's ACCESSOR (VaultAppToken row): an accessor
// cannot authenticate, but it lets the renewal loop below keep the (periodic)
// token alive and lets a re-mint revoke the app's previous token so exactly
// one credential per app is ever live.
async function mintAppToken(name, actorUid) {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
		throw new Error('invalid app name (lowercase letters, digits, hyphens; max 63 chars)');
	}
	await ensurePolicy(`app-${name}`, await appPolicyHcl(name));
	// App tokens are long-lived credentials: mint via the sso-app role (768h
	// period) so a renewal inside every 32-day window keeps them alive forever.
	// Fall back to the broker's own 24h role on deployments whose setup.sh
	// predates the sso-app role (re-running setup.sh creates it).
	let minted;
	try {
		minted = await mintToken([`app-${name}`], 'sso-app');
	} catch (e) {
		console.warn(`vault_broker: sso-app token role unavailable (${e.message}); falling back to sso-broker (24h period). Re-run theta-env setup.sh to create the sso-app role.`);
		minted = await mintToken([`app-${name}`]);
	}
	const { token, accessor, ttl } = minted;
	// Replace the app's accessor row; revoke the superseded token (best-effort —
	// it may already be expired) so re-minting never leaves a zombie credential.
	try {
		const existing = await VaultAppToken.getByName(name);
		if (existing) {
			await baoConf.request('POST', 'auth/token/revoke-accessor', { accessor: existing.accessor });
			await existing.delete();
		}
		if (accessor) {
			await VaultAppToken.create({
				name, accessor,
				lastRenewedAt: Date.now(),
				created_by: actorUid, created_on: Date.now(),
			});
		}
	} catch (e) {
		// Accessor bookkeeping must never block handing the token out; without a
		// row the token simply isn't auto-renewed (it still lives one full period).
		console.error(`vault_broker: could not store accessor for app-${name}:`, e.message);
	}
	return { token, ttl, policy: `app-${name}`, path: `secret/apps/${name}/` };
}

// ── App-token renewal loop ──────────────────────────────────────────────────
// Walks the stored accessors and renews each token (auth/token/renew-accessor),
// resetting its periodic clock. Runs at boot and then every RENEW_INTERVAL_MS —
// far inside both possible periods (24h fallback and 768h), so a downstream
// app's token stays valid for as long as sso is running. Failures are recorded
// on the row (visible to admins in the DB / future UI) and never throw.
const RENEW_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h — several chances per 24h period
let renewTimer;

async function renewAppTokens() {
	let rows;
	try { rows = await VaultAppToken.list(); }
	catch (e) { console.error('vault_broker: app-token renewal: could not list accessors:', e.message); return; }
	for (const row of rows) {
		try {
			const res = await baoConf.request('POST', 'auth/token/renew-accessor', { accessor: row.accessor });
			if (res.ok) {
				await row.update({ lastRenewedAt: Date.now(), lastError: null });
			} else {
				const text = await res.text().catch(() => '');
				// 400 "invalid accessor" = token expired or was revoked out-of-band;
				// keep the row + error so the admin can see the app needs a re-mint.
				await row.update({ lastError: `renew failed (${res.status}) ${text}` });
				console.warn(`vault_broker: renew of app token '${row.name}' failed (${res.status}) — re-mint it from the vault UI if the app is still in use.`);
			}
		} catch (e) {
			try { await row.update({ lastError: e.message }); } catch (e2) { /* best-effort */ }
			console.error(`vault_broker: renew of app token '${row.name}' errored:`, e.message);
		}
	}
}

// Start the loop (idempotent). unref() so an open handle never blocks exit.
function startAppTokenRenewal() {
	if (renewTimer) return renewTimer;
	renewAppTokens().catch((e) => console.error('vault_broker: initial app-token renewal failed:', e.message));
	renewTimer = setInterval(() => {
		renewAppTokens().catch((e) => console.error('vault_broker: app-token renewal failed:', e.message));
	}, RENEW_INTERVAL_MS);
	if (renewTimer.unref) renewTimer.unref();
	return renewTimer;
}

// ── Grant / revoke shared-secret access ─────────────────────────────────────
// Creating a grant writes the DB row and then edits the grantee's policy content
// to add read on the shared path; revoking removes both. Because OpenBao parses
// policy content live, the change applies to the grantee's existing token
// immediately — no token re-mint, no cache invalidation needed.
async function grantSharedSecret(secretId, granteeType, granteeId, actorUid) {
	const grant = await SharedSecretGrant.create({
		secretId, granteeType, granteeId, capability: 'read',
		created_by: actorUid, created_on: Date.now(),
		updated_by: actorUid, updated_on: Date.now(),
	});
	await reconcileGrantee(granteeType, granteeId);
	return grant;
}

async function revokeSharedSecret(grantId, actorUid) {
	const grant = await SharedSecretGrant.get(grantId);
	if (!grant) return null;
	const { granteeType, granteeId } = grant;
	await grant.delete();
	await reconcileGrantee(granteeType, granteeId);
	return grant;
}

// Recompute and rewrite a grantee's policy content after a grant/revoke.
async function reconcileGrantee(granteeType, granteeId) {
	if (granteeType === 'user') {
		await ensurePolicy(`user-${granteeId}`, await userPolicyHcl(granteeId));
	} else if (granteeType === 'app') {
		await ensurePolicy(`app-${granteeId}`, await appPolicyHcl(granteeId));
	} else {
		throw new Error(`invalid granteeType: ${granteeType}`);
	}
}

// ── /api/vault proxy: scope guard + token-injecting proxy ───────────────────
// Replaces the old bare pass-through (which sent no X-Vault-Token and gated
// nothing). The guard mints a server-side token for the user (per-user or
// admin) and enforces the path prefix as defense-in-depth on top of the
// token's own policy; the proxy injects ONLY that token and strips the
// client's sso auth headers so OpenBao never sees them.

const VAULT_ADDR = process.env.VAULT_ADDR || 'http://openbao:8200';
const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];
const ADMIN_GROUP = 'app_sso_admin';

async function isAdmin(user) {
	try {
		await permission.byGroup(user, ADMIN_GROUPS);
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

	const norm = normalizeVaultPath(req.path);
	if (norm === null) {
		return res.status(403).json({ error: 'vault paths must be under /secret/' });
	}
	const userBase = `/secret/users/${uid}`;
	const sharedBase = `/secret/shared`;
	const allowed = admin || norm === userBase || norm.startsWith(userBase + '/') || norm === sharedBase || norm.startsWith(sharedBase + '/');
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
		pathRewrite: { '^/api/vault': '/v1' },
		// http-proxy-middleware v2 API: hooks are top-level onProxyReq/onError,
		// NOT the v3 `on: { proxyReq }` shape. v2 silently ignores an `on` key,
		// which shipped this proxy with NO token injection — every /api/vault
		// call reached OpenBao unauthenticated and 403'd.
		onProxyReq(proxyReq, req, res, options) {
			// Header ops MUST precede fixRequestBody: it write()s the parsed body
			// onto proxyReq, which flushes headers — setHeader after that throws
			// (swallowed upstream), silently dropping the token on every write.
			// Inject ONLY the server-minted scoped token; strip the client's
			// sso session/api auth so it never reaches OpenBao.
			proxyReq.setHeader('X-Vault-Token', req.vaultToken);
			proxyReq.removeHeader('auth-token');
			proxyReq.removeHeader('authorization');
			fixRequestBody(proxyReq, req, res, options);
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
		const result = await mintAppToken(name, req.user && req.user.uid);
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
	// app-token lifecycle
	renewAppTokens,
	startAppTokenRenewal,
	VaultAppToken,
	// sharing
	SharedSecret,
	SharedSecretGrant,
	userPolicyHcl,
	appPolicyHcl,
	grantSharedSecret,
	revokeSharedSecret,
	reconcileGrantee,
};
