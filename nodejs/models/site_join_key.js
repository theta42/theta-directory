'use strict';

const crypto = require('crypto');
const { Model } = require('@simpleworkjs/orm');

// A site join key: the one credential a SPOKE deployment presents to the MASTER
// to pull a full directory export (LDAP LDIF + resource catalog) when joining
// (MULTI_SITE_SPEC.md). It works like an agent join key — issued once, shown
// once, stored hashed, revocable, expirable.
//
// The master's POST /api/site/export authenticates callers with this key; the
// spoke's POST /api/site/join consumes it. The `stj_` prefix distinguishes a
// site join key from an agent token / `tjk_` agent join key at a glance.
class SiteJoinKey extends Model {
	static hashKey(raw) {
		return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
	}

	static generateKey() {
		return 'stj_' + crypto.randomBytes(32).toString('hex');
	}

	// Resolve a presented key to a usable site join key, or null. Expiry and
	// revocation are enforced here so no caller can forget one.
	static async authenticate(rawKey) {
		if (!rawKey || typeof rawKey !== 'string') return null;
		const keyHash = this.hashKey(rawKey);
		const matches = await this.list({ where: { keyHash } });
		const key = matches && matches[0];
		if (!key) return null;
		if (key.revoked) return null;
		if (key.expires_on && key.expires_on < Math.floor(Date.now() / 1000)) return null;
		return key;
	}

	static async issue({ label, createdBy, expiresInDays }) {
		const raw = this.generateKey();
		const key = await this.create({
			id: crypto.randomUUID(),
			label: label || 'default',
			keyHash: this.hashKey(raw),
			keyPrefix: raw.slice(0, 12),
			revoked: false,
			created_by: createdBy || null,
			created_on: Math.floor(Date.now() / 1000),
			expires_on: expiresInDays ? Math.floor(Date.now() / 1000) + expiresInDays * 86400 : null,
			use_count: 0
		});
		return { key, raw };
	}

	static fields = {
		id: { type: 'uuid', primaryKey: true },
		label: { type: 'string', isRequired: true },
		keyHash: { type: 'string', isRequired: true },
		keyPrefix: { type: 'string' },
		revoked: { type: 'boolean', default: false },
		created_by: { type: 'string' },
		created_on: { type: 'integer' },
		expires_on: { type: 'integer' },
		use_count: { type: 'integer', default: 0 },
		last_used_on: { type: 'integer' }
	};

	toPublic() {
		const data = this.toJSON ? this.toJSON() : { ...this };
		delete data.keyHash;
		return data;
	}
}

module.exports = { SiteJoinKey };
