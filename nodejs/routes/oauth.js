'use strict';

const crypto = require('crypto');
const { execSync } = require('child_process');
const jwt = require('jsonwebtoken');
const express = require('express');
const conf = require('@simpleworkjs/conf');
const { OAuthClient } = require('../models/oauth_client');
const { OAuthCode, OAuthAccessToken, OAuthRefreshToken } = require('../models/oauth_code');
const { User } = require('../models/user');

const oauthConf = conf.oauth || {};
const issuer = oauthConf.issuer || `http://localhost:${conf.port || 3000}`;
const jwtSecret = oauthConf.jwtSecret || 'change-me-in-secrets';

const { version: buildVersion } = require('../package.json');
let buildHash = 'unknown';
try { buildHash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch(_) {}

const pageLocals = {
	title: conf.environment !== 'production' ? 'dev' : '',
	titleIcon: conf.environment !== 'production' ? '<i class="fa-brands fa-dev"></i>' : '',
	name: conf.name,
	buildVersion,
	buildHash,
	buildYear: new Date().getFullYear(),
};

// --- helpers ---

function makeError(name, message, status) {
	const error = new Error(name);
	error.name = name;
	error.message = message;
	error.status = status;
	return error;
}

function verifyPKCE(code_verifier, code_challenge, method) {
	if (method !== 'S256') return false;
	const hash = crypto.createHash('sha256').update(code_verifier).digest();
	const b64 = hash.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	return b64 === code_challenge;
}

function parseClientAuth(req) {
	// Support Basic auth header and POST body
	const auth = req.headers['authorization'];
	if (auth && auth.startsWith('Basic ')) {
		const [client_id, client_secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
		return { client_id, client_secret };
	}
	return {
		client_id: req.body.client_id,
		client_secret: req.body.client_secret,
	};
}

function buildIdToken(user, client, scope, now) {
	const scopes = scope.split(' ');
	const claims = {
		iss: issuer,
		sub: user.uid,
		aud: client.client_id,
		iat: Math.floor(now / 1000),
		exp: Math.floor(now / 1000) + (client.token_lifetime.access_token || 3600),
		preferred_username: user.uid,
	};

	if (scopes.includes('profile')) {
		claims.name = `${user.givenName} ${user.sn}`;
		claims.given_name = user.givenName;
		claims.family_name = user.sn;
	}
	if (scopes.includes('email')) {
		claims.email = user.mail;
	}

	return jwt.sign(claims, jwtSecret, { algorithm: 'HS256' });
}

function userClaims(user, scope) {
	const scopes = scope.split(' ');
	const claims = { sub: user.uid };

	if (scopes.includes('profile')) {
		claims.name = `${user.givenName} ${user.sn}`;
		claims.given_name = user.givenName;
		claims.family_name = user.sn;
		claims.preferred_username = user.uid;
	}
	if (scopes.includes('email')) {
		claims.email = user.mail;
	}

	return claims;
}

// --- page router (mounted at /oauth) ---

const router = express.Router();

// Consent page — validates OAuth params and renders the consent UI.
// The actual code issuance happens via POST /api/oauth/authorize (authenticated).
router.get('/authorize', async function(req, res, next) {
	try {
		const { response_type, client_id, redirect_uri, scope, state, code_challenge, code_challenge_method } = req.query;

		if (response_type !== 'code') {
			return next(makeError('UnsupportedResponseType', 'Only response_type=code is supported.', 400));
		}
		if (!code_challenge) {
			return next(makeError('PKCERequired', 'code_challenge is required.', 400));
		}
		if ((code_challenge_method || 'S256') !== 'S256') {
			return next(makeError('UnsupportedMethod', 'Only code_challenge_method=S256 is supported.', 400));
		}

		let client;
		try {
			client = await OAuthClient.get(client_id);
		} catch(_) {
			return next(makeError('InvalidClient', 'Unknown client_id.', 400));
		}

		if (!client.is_valid) {
			return next(makeError('InvalidClient', 'Client is disabled.', 400));
		}
		if (!client.redirect_uris.includes(redirect_uri)) {
			return next(makeError('InvalidRedirectURI', 'redirect_uri is not registered for this client.', 400));
		}

		const requestedScopes = (scope || '').split(' ').filter(Boolean);
		const allowedScopes = requestedScopes.filter(s => client.scopes.includes(s));

		res.render('oauth_authorize', {
			...pageLocals,
			oauthClient: {
				client_id: client.client_id,
				name: client.name,
				description: client.description,
			},
			params: {
				response_type,
				client_id,
				redirect_uri,
				scope: allowedScopes.join(' '),
				state: state || '',
				code_challenge,
				code_challenge_method: code_challenge_method || 'S256',
			},
			scopes: allowedScopes,
		});
	} catch(error) {
		next(error);
	}
});

// Token endpoint — exchanges auth codes and refresh tokens.
router.post('/token', express.urlencoded({ extended: false }), async function(req, res, next) {
	try {
		const { grant_type, code, redirect_uri, code_verifier, refresh_token } = req.body;
		const { client_id, client_secret } = parseClientAuth(req);

		// Authenticate the client
		let client;
		try {
			client = await OAuthClient.get(client_id);
		} catch(_) {
			return res.status(401).json({ error: 'invalid_client', error_description: 'Unknown client.' });
		}
		if (!client.is_valid || !(await client.verifySecret(client_secret))) {
			return res.status(401).json({ error: 'invalid_client', error_description: 'Client authentication failed.' });
		}

		const now = Date.now();

		if (grant_type === 'authorization_code') {
			let authCode;
			try {
				authCode = await OAuthCode.get(code);
			} catch(_) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code not found.' });
			}

			if (!authCode.is_valid || authCode.isExpired) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'Authorization code has expired or been used.' });
			}
			if (authCode.client_id !== client_id) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'Code was not issued to this client.' });
			}
			if (authCode.redirect_uri !== redirect_uri) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri does not match.' });
			}
			if (authCode.code_challenge && !verifyPKCE(code_verifier, authCode.code_challenge, authCode.code_challenge_method)) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed.' });
			}

			// Consume the code
			await authCode.update({ is_valid: false });

			const user = await User.get(authCode.username);
			const accessExpires = now + (client.token_lifetime.access_token * 1000);
			const refreshExpires = now + (client.token_lifetime.refresh_token * 1000);

			const [accessToken, refreshToken] = await Promise.all([
				OAuthAccessToken.add({ username: authCode.username, client_id, scope: authCode.scope, expires_at: accessExpires }),
				OAuthRefreshToken.add({ username: authCode.username, client_id, scope: authCode.scope, expires_at: refreshExpires }),
			]);

			const response = {
				access_token: accessToken.token,
				token_type: 'Bearer',
				expires_in: client.token_lifetime.access_token,
				refresh_token: refreshToken.token,
			};

			if (authCode.scope.split(' ').includes('openid')) {
				response.id_token = buildIdToken(user, client, authCode.scope, now);
			}

			return res.json(response);

		} else if (grant_type === 'refresh_token') {
			let oldRefreshToken;
			try {
				oldRefreshToken = await OAuthRefreshToken.get(refresh_token);
			} catch(_) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token not found.' });
			}

			if (!oldRefreshToken.is_valid || oldRefreshToken.isExpired) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token has expired or been revoked.' });
			}
			if (oldRefreshToken.client_id !== client_id) {
				return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token was not issued to this client.' });
			}

			// Rotate — invalidate old, issue new
			await oldRefreshToken.update({ is_valid: false });

			const user = await User.get(oldRefreshToken.username);
			const accessExpires = now + (client.token_lifetime.access_token * 1000);
			const refreshExpires = now + (client.token_lifetime.refresh_token * 1000);

			const [accessToken, newRefreshToken] = await Promise.all([
				OAuthAccessToken.add({ username: oldRefreshToken.username, client_id, scope: oldRefreshToken.scope, expires_at: accessExpires }),
				OAuthRefreshToken.add({ username: oldRefreshToken.username, client_id, scope: oldRefreshToken.scope, expires_at: refreshExpires }),
			]);

			const response = {
				access_token: accessToken.token,
				token_type: 'Bearer',
				expires_in: client.token_lifetime.access_token,
				refresh_token: newRefreshToken.token,
			};

			if (oldRefreshToken.scope.split(' ').includes('openid')) {
				response.id_token = buildIdToken(user, client, oldRefreshToken.scope, now);
			}

			return res.json(response);

		} else {
			return res.status(400).json({ error: 'unsupported_grant_type', error_description: `grant_type '${grant_type}' is not supported.` });
		}

	} catch(error) {
		next(error);
	}
});

// UserInfo endpoint — accepts a Bearer access token and returns user claims.
router.get('/userinfo', async function(req, res, next) {
	try {
		const auth = req.headers['authorization'];
		if (!auth || !auth.startsWith('Bearer ')) {
			res.set('WWW-Authenticate', 'Bearer');
			return res.status(401).json({ error: 'invalid_token', error_description: 'Bearer token required.' });
		}

		const tokenStr = auth.slice(7);
		let accessToken;
		try {
			accessToken = await OAuthAccessToken.get(tokenStr);
		} catch(_) {
			res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
			return res.status(401).json({ error: 'invalid_token', error_description: 'Access token not found.' });
		}

		if (!accessToken.is_valid || accessToken.isExpired) {
			res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
			return res.status(401).json({ error: 'invalid_token', error_description: 'Access token has expired.' });
		}

		const user = await User.get(accessToken.username);
		return res.json(userClaims(user, accessToken.scope));
	} catch(error) {
		next(error);
	}
});

// RP-initiated logout — clears the SSO browser session, then returns the user
// to the requesting app's post_logout_redirect_uri (if it belongs to a
// registered client, to prevent this being used as an open redirect).
router.get('/logout', async function(req, res, next) {
	try {
		const { post_logout_redirect_uri, state } = req.query;
		let target = '/';

		if (post_logout_redirect_uri) {
			let requested;
			try {
				requested = new URL(post_logout_redirect_uri);
			} catch(_) {
				return next(makeError('InvalidRequest', 'post_logout_redirect_uri is not a valid URL.', 400));
			}

			const clients = await OAuthClient.listDetail();
			const allowed = clients.some(client =>
				(client.redirect_uris || []).some(uri => {
					try { return new URL(uri).origin === requested.origin; }
					catch(_) { return false; }
				})
			);

			if (!allowed) {
				return next(makeError('InvalidRedirectURI', 'post_logout_redirect_uri origin is not registered for any client.', 400));
			}

			if (state) requested.searchParams.set('state', state);
			target = requested.toString();
		}

		res.render('oauth_logout', { ...pageLocals, target });
	} catch(error) {
		next(error);
	}
});

// --- authenticated API router (mounted at /api/oauth with auth middleware) ---

const authRouter = express.Router();

// Issues an authorization code after the user approves the consent form.
authRouter.post('/authorize', async function(req, res, next) {
	try {
		const { client_id, redirect_uri, scope, state, code_challenge, code_challenge_method, response_type } = req.body;

		if (response_type !== 'code') {
			return next(makeError('UnsupportedResponseType', 'Only response_type=code is supported.', 400));
		}

		let client;
		try {
			client = await OAuthClient.get(client_id);
		} catch(_) {
			return next(makeError('InvalidClient', 'Unknown client_id.', 400));
		}

		if (!client.is_valid) {
			return next(makeError('InvalidClient', 'Client is disabled.', 400));
		}
		if (!client.redirect_uris.includes(redirect_uri)) {
			return next(makeError('InvalidRedirectURI', 'redirect_uri is not registered for this client.', 400));
		}

		const authCode = await OAuthCode.add({
			username: req.user.uid,
			client_id,
			redirect_uri,
			scope: scope || 'openid',
			code_challenge: code_challenge || '',
			code_challenge_method: code_challenge_method || 'S256',
		});

		const redirectUrl = new URL(redirect_uri);
		redirectUrl.searchParams.set('code', authCode.token);
		if (state) redirectUrl.searchParams.set('state', state);

		return res.json({ redirect_url: redirectUrl.toString() });
	} catch(error) {
		next(error);
	}
});

// --- discovery document (used directly in app.js) ---

function discovery(req, res) {
	const base = issuer.replace(/\/$/, '');
	res.json({
		issuer: base,
		authorization_endpoint: `${base}/oauth/authorize`,
		token_endpoint: `${base}/oauth/token`,
		userinfo_endpoint: `${base}/oauth/userinfo`,
		end_session_endpoint: `${base}/oauth/logout`,
		scopes_supported: ['openid', 'profile', 'email'],
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
		subject_types_supported: ['public'],
		id_token_signing_alg_values_supported: ['HS256'],
	});
}

module.exports = { router, authRouter, discovery };
