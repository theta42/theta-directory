'use strict';

const Table = require('.');
const UUID = function b(a){return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,b)};

// Shared base keyMap matching Token's schema so these behave as tokens
const tokenKeyMap = {
	'created_by': {isRequired: true, type: 'string', min: 3, max: 500},
	'created_on': {default: function(){return (new Date).getTime()}},
	'updated_on': {default: function(){return (new Date).getTime()}, always: true},
	'token':      {default: UUID, type: 'string', min: 36, max: 36, isPrivate: true},
	'is_valid':   {default: true, type: 'boolean'},
};

class OAuthCode extends Table {
	static _key = 'token';
	static _keyMap = {
		...tokenKeyMap,
		'client_id':             {isRequired: true, type: 'string'},
		'redirect_uri':          {isRequired: true, type: 'string'},
		'scope':                 {isRequired: true, type: 'string'},
		'username':              {isRequired: true, type: 'string'},
		'code_challenge':        {default: '', type: 'string'},
		'code_challenge_method': {default: 'S256', type: 'string'},
		'expires_at':            {default: function(){return (new Date).getTime() + 600000}, type: 'number'},
	}

	get isExpired() {
		return (new Date).getTime() > this.expires_at;
	}

	static async add(data) {
		data.created_by = data.username;
		return this.create(data);
	}
}
OAuthCode.register();

class OAuthAccessToken extends Table {
	static _key = 'token';
	static _keyMap = {
		...tokenKeyMap,
		'client_id':  {isRequired: true, type: 'string'},
		'username':   {isRequired: true, type: 'string'},
		'scope':      {isRequired: true, type: 'string'},
		'expires_at': {isRequired: true, type: 'number'},
	}

	get isExpired() {
		return (new Date).getTime() > this.expires_at;
	}

	static async add(data) {
		data.created_by = data.username;
		return this.create(data);
	}
}
OAuthAccessToken.register();

class OAuthRefreshToken extends Table {
	static _key = 'token';
	static _keyMap = {
		...tokenKeyMap,
		'client_id':  {isRequired: true, type: 'string'},
		'username':   {isRequired: true, type: 'string'},
		'scope':      {isRequired: true, type: 'string'},
		'expires_at': {isRequired: true, type: 'number'},
	}

	get isExpired() {
		return (new Date).getTime() > this.expires_at;
	}

	static async add(data) {
		data.created_by = data.username;
		return this.create(data);
	}
}
OAuthRefreshToken.register();

module.exports = { OAuthCode, OAuthAccessToken, OAuthRefreshToken };
