'use strict';

const {User} = require('./user');
const {Token, AuthToken} = require('./token');

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
		console.error("AUTH LOGIN error:", error);
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

Auth.logOut = async function(data){
	try{
		let token = await AuthToken.get(data);
		await token.remove();
	}catch(error){
		throw error;
	}
}

module.exports = {Auth, AuthToken};
