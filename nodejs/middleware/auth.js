'use strict';

const {Auth} = require('../models/auth'); 

async function auth(req, res, next){
	try{
		// API-only token: `Authorization: Bearer sso_<id>_<secret>`.
		// Takes precedence over the browser session header so a script can call
		// the same /api/* routes the UI uses.
		const authz = req.header('authorization') || '';
		if(authz.slice(0, 7).toLowerCase() === 'bearer '){
			const tokenStr = authz.slice(7);
			if (tokenStr.startsWith('sso_')) {
				const user = await Auth.checkApiToken(tokenStr);
				if(user && user.uid){
					req.user = user;
					return next();
				}
			} else {
				// Machine token (ServiceToken)
				const { ServiceToken } = require('../models/token');
				let svcToken;
				try { svcToken = await ServiceToken.get(tokenStr); } catch(e) {}
				if (svcToken && svcToken.is_valid) {
					req.user = { uid: svcToken.resource_id, isMachine: true, name: 'Machine Account' };
					req.resourceId = svcToken.resource_id;
					return next();
				}
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
		// No token in the handshake (e.g. a page hit before login, or a socket
		// opened while logged out) → reject the socket cleanly without doing an
		// AuthToken.get(0) lookup that throws a noisy EntryNotFound trace.
		let tok = socket.handshake.auth && socket.handshake.auth.token;
		if(!tok) return next(Auth.errors.login());
		let token = await Auth.checkToken(tok);
		socket.user = await token.getUser();
		next();
	}catch(error){
		next(error);
	}
}

module.exports = {auth, authIO};
