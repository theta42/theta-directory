'use strict';

const {Auth} = require('../models/auth'); 

async function auth(req, res, next){
	try{
		// API-only token: `Authorization: Bearer sso_<id>_<secret>` or `Bearer <join_key>` with `x-forwarded-user`.
		// Takes precedence over the browser session header so a script can call
		// the same /api/* routes the UI uses.
		const authz = req.header('authorization') || '';
		if(authz.slice(0, 7).toLowerCase() === 'bearer '){
			const tokenStr = authz.slice(7).trim();

			// Inter-site spoke-forwarded request: `Authorization: Bearer <join_key_or_push_token>` with `X-Forwarded-User: <uid>`
			const fwdUser = req.header('x-forwarded-user');
			if (fwdUser) {
				const { SiteJoinKey } = require('../models/site_join_key');
				const { SiteSpoke } = require('../models/site_spoke');
				const isJoinKey = await SiteJoinKey.authenticate(tokenStr).catch(() => null);
				const isPushToken = !isJoinKey && await SiteSpoke.list({ where: { pushToken: tokenStr } }).then(l => l && l[0]).catch(() => null);
				if (isJoinKey || isPushToken) {
					const { User } = require('../models/user');
					const user = await User.get(fwdUser).catch(() => null);
					if (user && user.uid) {
						req.user = user;
						req.forwardedFromSpoke = req.header('x-forwarded-spoke') || 'spoke';
						return next();
					}
				}
			}

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
		// `Auth.checkToken` takes `{token}` (as middleware.auth passes it) and
		// returns the User itself — there is no `getUser()` on it. Passing the
		// bare string and then calling `token.getUser()` threw
		// "token.getUser is not a function" on every handshake, so no client in
		// this app has ever had a working socket. Group membership is resolved
		// live from LDAP by the read gate (utils/socket_pubsub.js), which needs
		// only `user.dn`.
		socket.user = await Auth.checkToken({token: tok});
		next();
	}catch(error){
		next(error);
	}
}

module.exports = {auth, authIO};
