'use strict';

const { Model } = require('@simpleworkjs/orm');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

// Self-service personal access token (PAT) for the SSO management API.
// Format:  sso_<id>_<secret>
//   id     — 24-char hex, stored plaintext as the record key (O(1) lookup)
//   secret — 48-char hex, stored only as a bcrypt hash (isPrivate); shown ONCE
// Authenticated via the `Authorization: Bearer sso_...` header (see
// middleware/auth.js + Auth.checkApiToken). A token authenticates AS its
// creator (created_by) and inherits their LDAP group permissions — the same
// permission.byGroup checks apply, re-resolved live from LDAP each request.
// No `static _ttl`: records persist (lifetime is the optional expires_at field).
//
// ApiToken is part of the replicated catalog so an `sso_...` token minted on
// the master is valid on every spoke. The secret hash travels in the export;
// the raw secret is never stored and only shown once at creation time.

const PREFIX = 'sso_';
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

class ApiToken extends Model {
	// Use uuid type for the primary key so @simpleworkjs/orm's Sequelize adapter
	// marks it as a primary key (StringField.toSequelize() does not). We always
	// supply a 24-char hex id at creation time, so the UUID default is unused.
	static fields = {
		id: { type: 'uuid', primaryKey: true },
		secret_hash: { type: 'string', isRequired: true, isPrivate: true },
		name: { type: 'string', isRequired: true, min: 1, max: 255 },
		description: { type: 'string', default: '' },
		created_by: { type: 'string', isRequired: true },
		created_on: { type: 'integer', default: () => Date.now() },
		updated_on: { type: 'integer', default: () => Date.now() },
		expires_at: { type: 'integer', default: 0 },
		last_used_on: { type: 'integer', default: 0 },
		is_valid: { type: 'boolean', default: true }
	};

	// Backwards-compatible with the Redis Table API the route used before.
	static async listDetail(args) {
		args = args || {};
		if (args.where) return this.list(args);
		return this.list({ where: args });
	}

	// Serialize for the multi-site export. `isPrivate` keeps the bcrypt hash
	// out of ordinary API responses, but spokes need the hash to authenticate
	// tokens minted on the master. Include it here and nowhere else.
	toReplica() {
		return {
			id: this.id,
			secret_hash: this.secret_hash,
			name: this.name,
			description: this.description,
			created_by: this.created_by,
			created_on: this.created_on,
			updated_on: this.updated_on,
			expires_at: this.expires_at,
			last_used_on: this.last_used_on,
			is_valid: this.is_valid
		};
	}

	get isExpired() {
		return this.expires_at > 0 && Date.now() > this.expires_at;
	}

	static async add(data) {
		const id = randomHex(12);
		const secret = randomHex(24);
		data.id = id;
		data.secret_hash = await bcrypt.hash(secret, 10);
		const token = await this.create(data);
		token._raw_token = `${PREFIX}${id}_${secret}`;
		return token;
	}

	async rotate() {
		const secret = randomHex(24);
		await this.update({ secret_hash: await bcrypt.hash(secret, 10) });
		return `${PREFIX}${this.id}_${secret}`;
	}

	// Validate a raw `sso_<id>_<secret>` string. Throws a generic Error on any
	// failure (wrong format / unknown id / bad secret / revoked / expired) so the
	// caller (Auth.checkApiToken) can collapse every case into one 401.
	static async authenticate(raw) {
		const m = /^sso_([0-9a-f]{24})_([0-9a-f]{48})$/i.exec(String(raw || ''));
		if (!m) throw new Error('InvalidApiToken');
		let token;
		try {
			token = await this.get(m[1]);
		} catch (e) {
			throw new Error('InvalidApiToken');
		}
		if (!token) throw new Error('InvalidApiToken');
		const ok = await bcrypt.compare(m[2], token.secret_hash);
		if (!ok || !token.is_valid || token.isExpired) throw new Error('InvalidApiToken');
		// Best-effort: stamp last use. Fire-and-forget so a SQLite hiccup never
		// fails an otherwise-valid request.
		try { await token.update({ last_used_on: Date.now() }); } catch (_) {}
		return token;
	}
}

// Keep updated_on fresh on every mutation the same way the Redis-backed
// Token family did with `always: true`.
ApiToken.beforeSave((data) => {
	data.updated_on = Date.now();
});

// One-time migration from the Redis-backed model-redis store used before
// v2.24.8. The old Table stored each token as a hash at
// <prefix>ApiToken_<id>. We copy those hashes into the replicated SQLite
// catalog so existing sso_... tokens keep working after the move. It is
// idempotent: rows already in SQLite are updated, not duplicated.
async function migrateFromRedis(Table) {
	if (!Table || !Table.redisClient) return;
	const client = Table.redisClient;
	const conf = require('@simpleworkjs/conf');
	const prefix = (conf.redis && conf.redis.prefix) || '';
	const match = `${prefix}ApiToken_*`;

	try {
		// model-redis's _scanKeys does not reliably walk the cursor with the
		// redis 6.x client used in production, so we drive SCAN directly. The
		// deployment has a small number of API tokens, so COUNT=1000 finishes
		// in a single (or very few) iteration(s).
		const keys = [];
		let cursor = '0';
		do {
			const reply = await client.scan(cursor, 'MATCH', match, 'COUNT', 1000);
			cursor = String(reply.cursor !== undefined ? reply.cursor : reply[0]);
			const batch = reply.keys !== undefined ? reply.keys : reply[1];
			for (const key of batch || []) keys.push(key);
		} while (cursor !== '0');

		if (!keys.length) return;

		// Defensive filter: only migrate keys that are Redis hashes and carry an
		// id field. A SCAN with a prefix can still pick up unrelated keys if the
		// live prefix changed over the deployment's lifetime.
		const hashKeys = [];
		for (const key of keys) {
			try {
				if (await client.type(key) === 'hash') hashKeys.push(key);
			} catch (_) {}
		}
		if (!hashKeys.length) return;

		let migrated = 0;
		for (const key of hashKeys) {
			const hash = await client.hGetAll(key);
			if (!hash || !hash.id) continue;
			const existing = await ApiToken.get(hash.id).catch(() => null);
			const fields = {
				secret_hash: hash.secret_hash,
				name: hash.name || 'Migrated token',
				description: hash.description || '',
				created_by: hash.created_by,
				created_on: Number(hash.created_on) || Date.now(),
				updated_on: Number(hash.updated_on) || Date.now(),
				expires_at: Number(hash.expires_at) || 0,
				last_used_on: Number(hash.last_used_on) || 0,
				is_valid: hash.is_valid !== 'false' && hash.is_valid !== false
			};
			try {
				if (existing) {
					await existing.update(fields);
				} else {
					await ApiToken.create({ id: hash.id, ...fields });
				}
				migrated++;
			} catch (e) {
				console.warn(`[ApiToken] failed to write ${hash.id}:`, e.message);
			}
		}
		if (migrated) console.log(`[ApiToken] migrated ${migrated} token(s) from Redis to SQLite`);
	} catch (e) {
		console.warn('[ApiToken] Redis migration best-effort failed:', e.message);
	}
}

module.exports = { ApiToken, migrateFromRedis };

