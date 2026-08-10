'use strict';

const crypto = require('crypto');
const { Model } = require('@simpleworkjs/orm');

// A spoke known to THIS node while it's acting as master — the registry that
// makes live replication possible. A spoke registers itself here (POST
// /api/site/spokes, authenticated by the same join key it used to join)
// right after adopting the master's export, handing over its own reachable
// endpoint. In return it's issued a `pushToken`: a shared secret the master
// then presents on every future POST <spoke endpoint>/api/site/resync call.
//
// This is a DIFFERENT credential direction than SiteJoinKey: a join key is
// presented TO the master and only ever needs to be verified (so it's stored
// hashed, like a password). pushToken is presented BY the master, repeatedly,
// so it has to be retrievable here -- there is no getting around storing it
// in plaintext on the master, the same way Webhook.secret is (see
// services/webhook_emitter.js) for the same reason (an HMAC/bearer credential
// the sender must keep re-presenting, not a one-time secret only ever
// verified).
class SiteSpoke extends Model {
	static generatePushToken() {
		return crypto.randomBytes(24).toString('base64url');
	}

	static fields = {
		id: { type: 'uuid', primaryKey: true },
		endpoint: { type: 'string', isRequired: true, unique: true },
		siteSlug: { type: 'string' },
		pushToken: { type: 'string', isRequired: true },
		created_on: { type: 'integer' },
		last_seen_on: { type: 'integer' }
	};

	toPublic() {
		const data = this.toJSON ? this.toJSON() : { ...this };
		delete data.pushToken;
		return data;
	}
}

module.exports = { SiteSpoke };
