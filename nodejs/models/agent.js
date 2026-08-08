'use strict';

const crypto = require('crypto');
const { Model } = require('@simpleworkjs/orm');

// A theta-agent enrolled against this SSO.
//
// Before this model existed the "agent token" was generated in the browser and
// never recorded anywhere, so the server had no way to tell an agent it issued
// from one someone invented -- /api/agent/ws accepted any string, and there was
// no way to revoke a token or to know that an agent existed while it was
// offline. The row is now the authority: an agent is only real if it is here.
//
// The raw token is shown exactly once, at enrollment. Only its SHA-256 lands in
// the database, so a database disclosure does not hand over working agent
// credentials. `tokenPrefix` is the first 8 characters, kept in the clear so the
// UI and logs can identify an agent without holding the secret.
class Agent extends Model {
	// Tokens are compared by hash on every WebSocket connect. SHA-256 (not
	// bcrypt) is deliberate: this runs on the connection path and the token is a
	// 256-bit random value, not a human-chosen password, so there is nothing for
	// a slow KDF to protect against here.
	static hashToken(raw) {
		return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
	}

	static generateToken() {
		return crypto.randomBytes(32).toString('hex');
	}

	// Resolve a presented token to its (non-revoked) agent, or null. Every
	// caller that authenticates an agent must go through here.
	static async authenticate(rawToken) {
		if (!rawToken || typeof rawToken !== 'string') return null;
		const tokenHash = this.hashToken(rawToken);
		const matches = await this.list({ where: { tokenHash } });
		const agent = matches && matches[0];
		if (!agent) return null;
		if (agent.revoked) return null;
		return agent;
	}

	// Enroll a new agent and return { agent, token }. The caller is responsible
	// for showing `token` to the operator once and never storing it.
	static async enroll({ name, resourceId, enrolledBy, description }) {
		const token = this.generateToken();
		const agent = await this.create({
			id: crypto.randomUUID(),
			name: name || 'theta-agent',
			description: description || null,
			tokenHash: this.hashToken(token),
			tokenPrefix: token.slice(0, 8),
			resourceId: resourceId || null,
			revoked: false,
			enrolled_by: enrolledBy || null,
			enrolled_on: Math.floor(Date.now() / 1000)
		});
		return { agent, token };
	}

	// Issue a fresh token for an existing agent, invalidating the old one.
	async rotateToken() {
		const token = Agent.generateToken();
		await this.update({
			tokenHash: Agent.hashToken(token),
			tokenPrefix: token.slice(0, 8),
			revoked: false
		});
		return token;
	}

	static fields = {
		id: { type: 'uuid', primaryKey: true },
		name: { type: 'string', isRequired: true },
		description: { type: 'text' },
		// Never the raw token. See hashToken above.
		tokenHash: { type: 'string', isRequired: true },
		tokenPrefix: { type: 'string' },
		// The host this agent runs on. Nullable so an agent can be enrolled
		// before its host exists in the Directory, but the UI pushes for it:
		// without this link there is nothing to hang resource control off, and
		// the old code had to guess by matching hostnames to slugs.
		resource: { type: 'hasOne', model: 'Resource' }, // creates resourceId
		revoked: { type: 'boolean', default: false },
		enrolled_by: { type: 'string' },
		enrolled_on: { type: 'integer' },
		// Survives a restart, which the in-memory map did not: an agent that is
		// installed but currently down is now distinguishable from one that was
		// never enrolled.
		last_seen: { type: 'integer' },
		last_ip: { type: 'string' },
		lastDiscovery: { type: 'json', default: {} },
		lastTelemetry: { type: 'json', default: {} }
	};

	// The shape the admin API returns. Never includes tokenHash.
	toPublic(liveState) {
		const data = this.toJSON ? this.toJSON() : { ...this };
		delete data.tokenHash;
		return {
			...data,
			lastSeen: data.last_seen ? new Date(data.last_seen * 1000).toISOString() : null,
			connected: !!(liveState && liveState.connected),
			// "Online" is a live-connection fact, not a stored one. A row with a
			// last_seen from an hour ago is an installed agent that is down.
			isOnline: !!(liveState && liveState.connected),
			lastResponse: (liveState && liveState.lastResponse) || null
		};
	}
}

// A join key: the one credential an operator hands out so a host can enroll
// itself. Requiring an admin to pre-register every machine before the agent
// would talk to them made adding a host a two-system chore -- installing the
// agent should be enough.
//
// A join key is NOT the agent's long-term credential. On first connect the
// server auto-enrolls the host and issues it a unique per-agent token, which
// the agent persists and uses from then on (PROTOCOL.md 1.2). That keeps the
// operator experience to "one key" while still giving every host its own
// revocable identity -- revoking a single agent means something, and a host
// that is compromised does not hand over the credential for the whole fleet.
class AgentJoinKey extends Model {
	static hashKey(raw) {
		return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
	}

	static generateKey() {
		// `tjk_` so an operator can tell a join key from an agent token at a
		// glance -- they are handled very differently.
		return 'tjk_' + crypto.randomBytes(32).toString('hex');
	}

	// Resolve a presented key to a usable join key, or null. Expiry and
	// revocation are both enforced here so no caller can forget one.
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

module.exports = { Agent, AgentJoinKey };
