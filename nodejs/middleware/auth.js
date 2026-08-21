'use strict';

const {Auth} = require('../models/auth'); 

async function auth(req, res, next){
	try{
		// API-only token: `Authorization: Bearer sso_<id>_<secret>`, or a spoke's
		// own `Bearer <push_token>` with `x-forwarded-user`. Takes precedence
		// over the browser session header so a script can call the same /api/*
		// routes the UI uses.
		const authz = req.header('authorization') || '';
		if(authz.slice(0, 7).toLowerCase() === 'bearer '){
			const tokenStr = authz.slice(7).trim();

			// Inter-site spoke-forwarded write (middleware/spoke_write_proxy.js):
			// `Authorization: Bearer <SiteSpoke.pushToken>` + `X-Forwarded-User: <uid>`.
			//
			// ONLY a push token is accepted here, deliberately. This used to also
			// accept a site JOIN key, which made it a cluster-wide impersonation
			// credential: a join key is minted for operators, pasted into every
			// spoke's spoke.env, and printed in setup output, and it bought
			// nothing more than a directory export — so anyone holding one could
			// assert `X-Forwarded-User: <any uid>` and act as that user on the
			// master, god_admin included. A push token is per-spoke, minted by
			// the master, and never leaves that spoke's /config/site.json.
			//
			// The spoke is identified by the token, never by the header: when the
			// caller also sends X-Forwarded-Spoke it must agree with the row the
			// token resolved to, so one spoke cannot masquerade as another in the
			// audit trail.
			const fwdUser = req.header('x-forwarded-user');
			if (fwdUser) {
				const siteConfig = require('../utils/site_config');
				const cfg = siteConfig.get();
				const isMasterCalling = !cfg.isMaster && cfg.replicationPushToken && cfg.replicationPushToken === tokenStr;

				const { SiteSpoke } = require('../models/site_spoke');
				const spoke = isMasterCalling ? { siteSlug: 'master' } : await SiteSpoke.list({ where: { pushToken: tokenStr } })
					.then(l => l && l[0]).catch(() => null);
				const claimedSlug = req.header('x-forwarded-spoke');
				const slugMatches = !claimedSlug || !spoke || !spoke.siteSlug || claimedSlug === spoke.siteSlug;
				if (spoke && slugMatches) {
					const { User } = require('../models/user');
					const user = await User.get(fwdUser).catch(() => null);
					if (user && user.uid) {
						req.user = user;
						req.forwardedFromSpoke = spoke.siteSlug || 'cluster';
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
