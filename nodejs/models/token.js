'use strict';

const Table = require('.');
const crypto = require('crypto');
const UUID = () => crypto.randomUUID();


class Token extends Table{
	static _key = 'token';
	static _keyMap = {
		'created_by': {isRequired: true, type: 'string', min: 3, max: 500},
		'created_on': {default: function(){return (new Date).getTime()}},
		'updated_on': {default: function(){return (new Date).getTime()}, always: true},
		'token': {default: UUID, type: 'string', min: 36, max: 36, isPrivate: true},
		'is_valid': {default: true, type: 'boolean'},	
	}

	constructor(...args){
		super(...args);
	}

	async check(){
		try{
			return this.is_valid;
		}catch(error){
			return false
		}
	}
}

Token.register();

class AuthToken extends Token{
	static _keyMap = {
		...super._keyMap,
		user: {model: 'User', rel: 'one', localKey: 'created_by'},
	}

	static async create(data){
		data.created_by = data.username;
		return super.create(data)

	}
}
AuthToken.register();

class InviteToken extends Token{
	static _keyMap = {
		...super._keyMap,
		claimed_by:  {default: '__NONE__', isRequired: false, type: 'string'},
		mail:        {default: '__NONE__', type: 'string'},
		mail_token:  {default: '__NONE__', type: 'string'},
		groups:      {default: '[]',       type: 'string'},
	}

	async consume(data){
		try{
			if(this.is_valid){
				data['is_valid'] = false;

				await this.update(data);
				return true;
			}
			return false;

		}catch(error){
			throw error;
		}
	}
}
InviteToken.register();

class ImpersonationToken extends Token {
	static _keyMap = {
		...super._keyMap,
		target_uid: {isRequired: true, type: 'string', min: 1, max: 200},
		temp_hash:  {isRequired: true, type: 'string', min: 1, max: 500},
		expires_at: {default: function(){ return (new Date).getTime() + 7200000 }, type: 'number'},
	}

	get isExpired() {
		return (new Date).getTime() > this.expires_at;
	}

	static async add(data) {
		data.created_by = data.admin_uid;
		return this.create(data);
	}
}
ImpersonationToken.register();

class PasswordResetToken extends Token {}
PasswordResetToken.register();

class OtpToken extends Token {
	static _keyMap = {
		...Token._keyMap,
		uid:        {isRequired: true, type: 'string'},
		code:       {isRequired: true, type: 'string'},
		method:     {isRequired: true, type: 'string'},
		expires_at: {default: function(){ return (new Date).getTime() + 600000 }, type: 'number'},
	};

	get isExpired() {
		return (new Date).getTime() > this.expires_at;
	}

	// Factory method — named `issue` to avoid shadowing Token's `create(data)`
	static async issue(uid, method) {
		const existing = await this.listDetail({uid});
		for (const t of existing) {
			if (t.is_valid) await t.update({is_valid: false});
		}
		const code = String(crypto.randomInt(100000, 1000000));
		return this.create({uid, code, method, created_by: uid});
	}

	static async verify(uid, code) {
		const tokens = await this.listDetail({uid});
		const match = tokens.find(t => t.is_valid && !t.isExpired && t.code === code);
		if (!match) return null;
		await match.update({is_valid: false});
		return match;
	}
}
OtpToken.register();

module.exports = {Token, InviteToken, AuthToken, ImpersonationToken, PasswordResetToken, OtpToken};
