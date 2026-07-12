'use strict';

const {Auth} = require('../models/auth'); 

async function auth(req, res, next){
	try{
		// API-only token: `Authorization: Bearer sso_<id>_<secret>`.
		// Takes precedence over the browser session header so a script can call
		// the same /api/* routes the UI uses.
		const authz = req.header('authorization') || '';
		if(authz.slice(0, 7).toLowerCase() === 'bearer '){
			const user = await Auth.checkApiToken(authz.slice(7));
			if(user && user.uid){
				req.user = user;
				return next();
			}
		}

		// Browser session: `auth-token: <AuthToken uuid>`.
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
