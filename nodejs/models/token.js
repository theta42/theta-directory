'use strict';

const { Model } = require('@simpleworkjs/orm');
const crypto = require('crypto');
const UUID = () => crypto.randomUUID();

class Token extends Model {
	static adapterName = 'redis';
	static fields = {
		token: { type: 'string', primaryKey: true, default: UUID, isPrivate: true, min: 36, max: 36 },
		created_by: { isRequired: true, type: 'string', min: 3, max: 500 },
		created_on: { type: 'integer', default: function(){return (new Date).getTime()} },
		updated_on: { type: 'integer', default: function(){return (new Date).getTime()}, always: true },
		is_valid: { default: true, type: 'boolean' }
	}

	async check(){
		try{
			return this.is_valid;
		}catch(error){
			return false
		}
	}
}

class AuthToken extends Token{
	static fields = {
		...Token.fields,
		user: {model: 'User', type: 'hasOne', localKey: 'created_by'},
	}

	static async create(data){
		data.created_by = data.username;
		return super.create(data)

	}
}

class InviteToken extends Token{
	static fields = {
		...Token.fields,
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

class ImpersonationToken extends Token {
	static fields = {
		...Token.fields,
		target_uid: {isRequired: true, type: 'string', min: 1, max: 200},
		temp_hash:  {isRequired: true, type: 'string', min: 1, max: 500},
		expires_at: {default: function(){ return (new Date).getTime() + 7200000 }, type: 'integer'},
	}

	get isExpired() {
		return (new Date).getTime() > this.expires_at;
	}

	static async add(data) {
		data.created_by = data.admin_uid;
		return this.create(data);
	}
}

class PasswordResetToken extends Token {}

class OtpToken extends Token {
	static fields = {
		...Token.fields,
		uid:        {isRequired: true, type: 'string'},
		code:       {isRequired: true, type: 'string'},
		method:     {isRequired: true, type: 'string'},
		expires_at: {default: function(){ return (new Date).getTime() + 600000 }, type: 'integer'},
	};

	get isExpired() {
		return (new Date).getTime() > this.expires_at;
	}

	static async issue(uid, method) {
		const existing = await this.list({where: {uid}});
		for (const t of existing) {
			if (t.is_valid) await t.update({is_valid: false});
		}
		const code = String(crypto.randomInt(100000, 1000000));
		return this.create({uid, code, method, created_by: uid});
	}

	static async verify(uid, code) {
		const tokens = await this.list({where: {uid}});
		const match = tokens.find(t => t.is_valid && !t.isExpired && t.code === code);
		if (!match) return null;
		await match.update({is_valid: false});
		return match;
	}
}
class ServiceToken extends Token {
	static fields = {
		...Token.fields,
		resource_id: {isRequired: true, type: 'string'}
	}
	
	static async issue(resource_id, created_by) {
		return this.create({resource_id, created_by});
	}
}

module.exports = {Token, InviteToken, AuthToken, ImpersonationToken, PasswordResetToken, OtpToken, ServiceToken};
