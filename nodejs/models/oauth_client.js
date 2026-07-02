'use strict';

const Table = require('.');
const bcrypt = require('bcrypt');
const UUID = function b(a){return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,b)};
const conf = require('@simpleworkjs/conf');

const defaultLifetime = (conf.oauth && conf.oauth.token_lifetime) || {
	access_token: 3600,
	refresh_token: 2592000
};

class OAuthClient extends Table {
	static _key = 'client_id';
	static _keyMap = {
		'client_id':          {default: UUID, type: 'string'},
		'client_secret_hash': {isRequired: true, type: 'string', isPrivate: true},
		'name':               {isRequired: true, type: 'string', min: 1, max: 255},
		'description':        {default: '', type: 'string'},
		'redirect_uris':      {default: [], type: 'object'},
		'scopes':             {default: ['openid', 'profile', 'email', 'groups'], type: 'object'},
		'allowed_groups':     {default: [], type: 'object'},
		'token_lifetime':     {default: function(){ return Object.assign({}, defaultLifetime) }, type: 'object'},
		'created_by':         {isRequired: true, type: 'string'},
		'created_on':         {default: function(){ return (new Date).getTime() }},
		'is_valid':           {default: true, type: 'boolean'},
	}

	static async add(data) {
		const raw_secret = UUID();
		data.client_secret_hash = await bcrypt.hash(raw_secret, 10);
		data.client_id = UUID();
		const client = await this.create(data);
		client._raw_secret = raw_secret;
		return client;
	}

	async verifySecret(secret) {
		return bcrypt.compare(secret, this.client_secret_hash);
	}

	async rotateSecret() {
		const raw_secret = UUID();
		await this.update({ client_secret_hash: await bcrypt.hash(raw_secret, 10) });
		return raw_secret;
	}
}
OAuthClient.register();

module.exports = { OAuthClient };
