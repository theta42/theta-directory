'use strict';

const {Auth} = require('../models/auth'); 

async function auth(req, res, next){
	try{
		let user = await Auth.checkToken({token: req.header('auth-token')});

		if(user.uid){
			req.user = user;
			return next();
		}
	}catch(error){
		next(error);
	}
}

async function authIO(socket, next){
	try{
		let token = await Auth.checkToken(socket.handshake.auth.token || 0);
		socket.user = await token.getUser();
		next();
	}catch(error){
		next(error);
	}
}

module.exports = {auth, authIO};
