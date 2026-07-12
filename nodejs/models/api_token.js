'use strict';

const Table = require('.');
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

const PREFIX = 'sso_';
const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

class ApiToken extends Table {
	static _key = 'id';
	static _keyMap = {
		'id':           {default: function(){ return randomHex(12) }, type: 'string'},
		'secret_hash':  {isRequired: true, type: 'string', isPrivate: true},
		'name':         {isRequired: true, type: 'string', min: 1, max: 255},
		'description':  {default: '', type: 'string'},
		'created_by':   {isRequired: true, type: 'string'},
		'created_on':   {default: function(){ return (new Date).getTime() }},
		'updated_on':   {default: function(){ return (new Date).getTime() }, always: true},
		'expires_at':   {default: 0, type: 'number'}, // epoch ms; 0 = never
		'last_used_on': {default: 0, type: 'number'},
		'is_valid':     {default: true, type: 'boolean'},
	}

	get isExpired() {
		return this.expires_at > 0 && (new Date).getTime() > this.expires_at;
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
		// Best-effort: stamp last use. Fire-and-forget so a Redis hiccup never
		// fails an otherwise-valid request.
		try { await token.update({ last_used_on: (new Date).getTime() }); } catch (_) {}
		return token;
	}
}
ApiToken.register();

module.exports = { ApiToken };