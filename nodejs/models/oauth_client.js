'use strict';

const { Resource } = require('./resource');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const conf = require('@simpleworkjs/conf');
const UUID = () => crypto.randomUUID();

const defaultLifetime = (conf.oauth && conf.oauth.token_lifetime) || {
	access_token: 3600,
	refresh_token: 2592000
};

class OAuthClient {
	static async add(data) {
		const raw_secret = crypto.randomUUID();
		const client_id = crypto.randomUUID();
		const client_secret_hash = await bcrypt.hash(raw_secret, 10);
		
		const r = await Resource.create({
			id: client_id,
			kind: 'oauth',
			name: data.name,
			description: data.description || '',
			owner: data.created_by,
			metadata: {
				client_secret_hash,
				redirect_uris: data.redirect_uris || [],
				scopes: data.scopes || ['openid', 'profile', 'email', 'groups'],
				allowed_groups: data.allowed_groups || [],
				token_lifetime: data.token_lifetime || { ...defaultLifetime }
			}
		});
		
		r._raw_secret = raw_secret;
		r.client_id = client_id;
		return r;
	}
	static async get(client_id) {
		const resources = await Resource.list({ where: { id: client_id, kind: 'oauth' } });
		if (!resources.length) throw new Error('OAuthClient not found');
		
		const r = resources[0];
		// Map metadata to top-level properties to satisfy routes/oauth.js without rewriting it
		r.client_id = r.id;
		r.client_secret_hash = r.metadata.client_secret_hash;
		r.redirect_uris = r.metadata.redirect_uris || [];
		r.scopes = r.metadata.scopes || ['openid', 'profile', 'email', 'groups'];
		r.allowed_groups = r.metadata.allowed_groups || [];
		r.token_lifetime = r.metadata.token_lifetime || { ...defaultLifetime };
		r.verifySecret = async (secret) => bcrypt.compare(secret, r.client_secret_hash);
		
		r.rotateSecret = async () => {
			const raw_secret = crypto.randomUUID();
			r.metadata.client_secret_hash = await bcrypt.hash(raw_secret, 10);
			await r.update({ metadata: r.metadata });
			return raw_secret;
		};

		// proxy update to handle metadata correctly
		const originalUpdate = r.update.bind(r);
		r.update = async (data) => {
			if (data.redirect_uris !== undefined) r.metadata.redirect_uris = data.redirect_uris;
			if (data.scopes !== undefined) r.metadata.scopes = data.scopes;
			if (data.allowed_groups !== undefined) r.metadata.allowed_groups = data.allowed_groups;
			if (data.token_lifetime !== undefined) r.metadata.token_lifetime = data.token_lifetime;
			
			const updateData = { metadata: r.metadata };
			if (data.name !== undefined) updateData.name = data.name;
			if (data.description !== undefined) updateData.description = data.description;
			if (data.is_valid !== undefined) updateData.is_valid = data.is_valid;
			
			return originalUpdate(updateData);
		};

		return r;
	}

	static async list() {
		const resources = await Resource.list({ where: { kind: 'oauth' } });
		return Promise.all(resources.map(r => this.get(r.id)));
	}

	static async verifySecret(client_id, secret) {
		const client = await this.get(client_id);
		return client.verifySecret(secret);
	}
}

module.exports = { OAuthClient };
