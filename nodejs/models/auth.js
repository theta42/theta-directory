'use strict';

const {User} = require('./user');
const {Token, AuthToken} = require('./token');
const {ApiToken} = require('./api_token');

var Auth = {}
Auth.errors = {}

Auth.errors.login = function(){
	let error = new Error('LDAPLoginFailed');
	error.name = 'LDAPLoginFailed';
	error.message = `Invalid Credentials, login failed.`;
	error.status = 401;

	return error;
}

Auth.login = async function(data){
	try{
		let user = await User.login(data);
		let token = await AuthToken.create(user);

		return {user, token}
	}catch(error){
		console.error("AUTH LOGIN error:", error.name, error.message);
		throw this.errors.login();
	}
};


Auth.checkToken = async function(data){
	try{
		let token = await AuthToken.get(data);
		if(token.is_valid){
			return await User.get(token.created_by);
		}
		throw new Error('invalid token');
	}catch(error){
		throw this.errors.login();
	}
};

// Validate an `Authorization: Bearer sso_<id>_<secret>` API token and return the
// owning user (same shape as checkToken). Every failure collapses to the same
// generic login 401 — no leak of whether the token existed vs. wrong secret vs.
// expired. The token authenticates AS its creator; permissions are re-resolved
// from LDAP live (permission.byGroup), so no groups snapshot is stored.
Auth.checkApiToken = async function(raw){
	try{
		let token = await ApiToken.authenticate(raw);
		return await User.get(token.created_by);
	}catch(error){
		throw this.errors.login();
	}
};

Auth.logOut = async function(data){
	try{
		let token = await AuthToken.get(data);
		await token.remove();
	}catch(error){
		throw error;
	}
}

module.exports = {Auth, AuthToken};
