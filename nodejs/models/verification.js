'use strict';

const Table = require('.');

class UserVerification extends Table {
	static _key = 'uid';
	static _keyMap = {
		uid:               {isRequired: true, type: 'string'},
		created_by:        {isRequired: true, type: 'string'},
		email_verified:    {default: false, type: 'boolean'},
		phone_verified:    {default: false, type: 'boolean'},
		tos_accepted:         {default: false, type: 'boolean'},
		password_must_change: {default: false, type: 'boolean'},
		email_verified_at: {type: 'number'},
		phone_verified_at: {type: 'number'},
		tos_accepted_at:   {type: 'number'},
	};

	static async getOrCreate(uid) {
		const list = await this.listDetail({uid});
		if (list.length) return list[0];
		return this.create({uid, created_by: uid});
	}

	async markEmailVerified() {
		return this.update({email_verified: true, email_verified_at: Date.now()});
	}

	async markPhoneVerified() {
		return this.update({phone_verified: true, phone_verified_at: Date.now()});
	}

	async markTosAccepted() {
		return this.update({tos_accepted: true, tos_accepted_at: Date.now()});
	}
}
UserVerification.register();

module.exports = {UserVerification};
