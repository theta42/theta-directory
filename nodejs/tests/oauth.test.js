'use strict';

const { login, generatePKCE, request, app } = require('./setup');

const REDIRECT_URI = 'https://test.example.com/callback';

let token;
let clientId;
let clientSecret;

// Full OIDC Authorization Code + PKCE flow state
let authCode;
let accessToken;
let refreshToken;

beforeAll(async () => {
	token = await login();

	// Create a dedicated test OAuth client for the flow
	const res = await request(app)
		.post('/api/oauth/client/')
		.set('auth-token', token)
		.send({
			name: 'OAuth Flow Test',
			redirect_uris: REDIRECT_URI,
			scopes: 'openid profile email groups',
			token_lifetime: { access_token: 3600, refresh_token: 86400 },
		});

	if (res.status !== 200) {
		throw new Error('Could not create test OAuth client. Is test user in app_sso_oauth_admin? ' + JSON.stringify(res.body));
	}

	clientId = res.body.results.client_id;
	clientSecret = res.body.client_secret;
});

afterAll(async () => {
	if (clientId) {
		await request(app)
			.delete(`/api/oauth/client/${clientId}`)
			.set('auth-token', token);
	}
});

describe('OIDC Discovery', () => {
	test('GET /.well-known/openid-configuration returns required fields', async () => {
		const res = await request(app).get('/.well-known/openid-configuration');

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('issuer');
		expect(res.body).toHaveProperty('authorization_endpoint');
		expect(res.body).toHaveProperty('token_endpoint');
		expect(res.body).toHaveProperty('userinfo_endpoint');
		expect(res.body.response_types_supported).toContain('code');
		expect(res.body.grant_types_supported).toContain('authorization_code');
		expect(res.body.grant_types_supported).toContain('refresh_token');
		expect(res.body.code_challenge_methods_supported).toContain('S256');
	});

	test('advertises end_session_endpoint', async () => {
		const res = await request(app).get('/.well-known/openid-configuration');
		expect(res.body).toHaveProperty('end_session_endpoint');
	});
});

describe('OAuth — GET /oauth/logout (RP-initiated logout)', () => {
	test('renders logout page with no redirect', async () => {
		const res = await request(app).get('/oauth/logout');
		expect(res.status).toBe(200);
	});

	test('accepts a post_logout_redirect_uri on a registered client origin', async () => {
		const res = await request(app)
			.get('/oauth/logout')
			.query({ post_logout_redirect_uri: 'https://test.example.com/' });
		expect(res.status).toBe(200);
		expect(res.text).toContain('https://test.example.com/');
	});

	test('rejects a post_logout_redirect_uri on an unregistered origin', async () => {
		const res = await request(app)
			.get('/oauth/logout')
			.query({ post_logout_redirect_uri: 'https://evil.example.com/' });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe('OAuth — GET /oauth/authorize (consent page validation)', () => {
	test('rejects unknown client_id', async () => {
		const { challenge } = generatePKCE();
		const res = await request(app).get('/oauth/authorize').query({
			response_type: 'code',
			client_id: '00000000-0000-0000-0000-000000000000',
			redirect_uri: REDIRECT_URI,
			scope: 'openid',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('rejects unregistered redirect_uri', async () => {
		const { challenge } = generatePKCE();
		const res = await request(app).get('/oauth/authorize').query({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: 'https://evil.example.com/callback',
			scope: 'openid',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('rejects missing code_challenge (PKCE required)', async () => {
		const res = await request(app).get('/oauth/authorize').query({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			scope: 'openid',
		});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('valid params render the consent page', async () => {
		const { challenge } = generatePKCE();
		const res = await request(app).get('/oauth/authorize').query({
			response_type: 'code',
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			scope: 'openid profile email',
			state: 'teststate',
			code_challenge: challenge,
			code_challenge_method: 'S256',
		});
		// Returns HTML (the EJS consent page), not an error
		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toMatch(/html/);
	});
});

describe('OAuth — POST /api/oauth/authorize (code issuance)', () => {
	test('issues an authorization code for an authenticated user', async () => {
		const { challenge, verifier } = generatePKCE();

		const res = await request(app)
			.post('/api/oauth/authorize')
			.set('auth-token', token)
			.send({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				scope: 'openid profile email',
				state: 'teststate',
				code_challenge: challenge,
				code_challenge_method: 'S256',
			});

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('redirect_url');

		const redirectUrl = new URL(res.body.redirect_url);
		expect(redirectUrl.searchParams.get('code')).toBeTruthy();
		expect(redirectUrl.searchParams.get('state')).toBe('teststate');

		// Save for token exchange tests
		authCode = redirectUrl.searchParams.get('code');
		// Also save the verifier so token exchange works
		res._pkceVerifier = verifier;

		// Store verifier on the module scope for next describe block
		global.__testPkceVerifier = verifier;
	});

	test('requires auth — 401 without token', async () => {
		const { challenge } = generatePKCE();
		const res = await request(app)
			.post('/api/oauth/authorize')
			.send({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				scope: 'openid',
				code_challenge: challenge,
			});
		expect(res.status).toBe(401);
	});
});

describe('OAuth — POST /oauth/token (authorization_code grant)', () => {
	test('exchanges auth code + PKCE verifier for tokens', async () => {
		expect(authCode).toBeDefined();

		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code: authCode,
				redirect_uri: REDIRECT_URI,
				client_id: clientId,
				client_secret: clientSecret,
				code_verifier: global.__testPkceVerifier,
			});

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('access_token');
		expect(res.body).toHaveProperty('refresh_token');
		expect(res.body).toHaveProperty('id_token');
		expect(res.body.token_type).toBe('Bearer');
		expect(res.body.expires_in).toBe(3600);

		accessToken = res.body.access_token;
		refreshToken = res.body.refresh_token;
	});

	test('rejects reuse of the same auth code', async () => {
		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code: authCode,
				redirect_uri: REDIRECT_URI,
				client_id: clientId,
				client_secret: clientSecret,
				code_verifier: global.__testPkceVerifier,
			});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_grant');
	});

	test('rejects wrong code_verifier (PKCE mismatch)', async () => {
		// Get a fresh code first
		const { challenge, verifier } = generatePKCE();
		const codeRes = await request(app)
			.post('/api/oauth/authorize')
			.set('auth-token', token)
			.send({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				scope: 'openid',
				code_challenge: challenge,
				code_challenge_method: 'S256',
			});
		const freshCode = new URL(codeRes.body.redirect_url).searchParams.get('code');

		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code: freshCode,
				redirect_uri: REDIRECT_URI,
				client_id: clientId,
				client_secret: clientSecret,
				code_verifier: 'wrong-verifier-that-does-not-match',
			});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_grant');
	});

	test('rejects wrong client_secret', async () => {
		const { challenge } = generatePKCE();
		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code: 'doesnotmatter',
				redirect_uri: REDIRECT_URI,
				client_id: clientId,
				client_secret: 'wrong-secret',
				code_verifier: 'doesnotmatter',
			});
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('invalid_client');
	});
});

describe('OAuth — GET /oauth/userinfo', () => {
	test('returns user claims for valid access token', async () => {
		expect(accessToken).toBeDefined();

		const res = await request(app)
			.get('/oauth/userinfo')
			.set('Authorization', `Bearer ${accessToken}`);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('sub');
		// profile scope
		expect(res.body).toHaveProperty('name');
		expect(res.body).toHaveProperty('preferred_username');
		// email scope
		expect(res.body).toHaveProperty('email');
	});

	test('rejects missing Bearer token with 401', async () => {
		const res = await request(app).get('/oauth/userinfo');
		expect(res.status).toBe(401);
	});

	test('rejects invalid Bearer token with 401', async () => {
		const res = await request(app)
			.get('/oauth/userinfo')
			.set('Authorization', 'Bearer not-a-real-token');
		expect(res.status).toBe(401);
	});
});

describe('OAuth — POST /oauth/token (refresh_token grant)', () => {
	test('exchanges refresh token for new access + refresh tokens', async () => {
		expect(refreshToken).toBeDefined();

		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: clientId,
				client_secret: clientSecret,
			});

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('access_token');
		expect(res.body).toHaveProperty('refresh_token');
		// New tokens should be different (rotation)
		expect(res.body.access_token).not.toBe(accessToken);
		expect(res.body.refresh_token).not.toBe(refreshToken);

		accessToken = res.body.access_token;
		refreshToken = res.body.refresh_token;
	});

	test('rejects reuse of the old refresh token after rotation', async () => {
		// Capture the pre-rotation refresh token — it was rotated in the previous test
		// We need a fresh sequence for this test
		const { challenge, verifier } = generatePKCE();
		const codeRes = await request(app)
			.post('/api/oauth/authorize')
			.set('auth-token', token)
			.send({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				scope: 'openid',
				code_challenge: challenge,
				code_challenge_method: 'S256',
			});
		const freshCode = new URL(codeRes.body.redirect_url).searchParams.get('code');

		const tokenRes = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code: freshCode,
				redirect_uri: REDIRECT_URI,
				client_id: clientId,
				client_secret: clientSecret,
				code_verifier: verifier,
			});
		const oldRefresh = tokenRes.body.refresh_token;

		// Rotate it once
		await request(app)
			.post('/oauth/token')
			.type('form')
			.send({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId, client_secret: clientSecret });

		// Try to reuse the old one
		const reuseRes = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({ grant_type: 'refresh_token', refresh_token: oldRefresh, client_id: clientId, client_secret: clientSecret });

		expect(reuseRes.status).toBe(400);
		expect(reuseRes.body.error).toBe('invalid_grant');
	});
});

describe('OAuth — groups claim', () => {
	test('userinfo includes a groups array when the groups scope is granted', async () => {
		const { challenge, verifier } = generatePKCE();

		const codeRes = await request(app)
			.post('/api/oauth/authorize')
			.set('auth-token', token)
			.send({
				response_type: 'code',
				client_id: clientId,
				redirect_uri: REDIRECT_URI,
				scope: 'openid groups',
				code_challenge: challenge,
				code_challenge_method: 'S256',
			});
		const code = new URL(codeRes.body.redirect_url).searchParams.get('code');

		const tokRes = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code,
				redirect_uri: REDIRECT_URI,
				client_id: clientId,
				client_secret: clientSecret,
				code_verifier: verifier,
			});
		expect(tokRes.status).toBe(200);

		const uiRes = await request(app)
			.get('/oauth/userinfo')
			.set('Authorization', 'Bearer ' + tokRes.body.access_token);
		expect(uiRes.status).toBe(200);
		expect(Array.isArray(uiRes.body.groups)).toBe(true);
	});
});

describe('OAuth — allowed_groups access control', () => {
	let restrictedId;

	beforeAll(async () => {
		const res = await request(app)
			.post('/api/oauth/client/')
			.set('auth-token', token)
			.send({
				name: 'Restricted Group Test',
				redirect_uris: REDIRECT_URI,
				scopes: 'openid',
				allowed_groups: 'this_group_does_not_exist_xyz',
			});
		restrictedId = res.body.results && res.body.results.client_id;
	});

	afterAll(async () => {
		if (restrictedId) {
			await request(app).delete('/api/oauth/client/' + restrictedId).set('auth-token', token);
		}
	});

	test('denies a user who is not in any allowed group (403)', async () => {
		const { challenge } = generatePKCE();
		const res = await request(app)
			.post('/api/oauth/authorize')
			.set('auth-token', token)
			.send({
				response_type: 'code',
				client_id: restrictedId,
				redirect_uri: REDIRECT_URI,
				scope: 'openid',
				code_challenge: challenge,
				code_challenge_method: 'S256',
			});
		expect(res.status).toBe(403);
	});
});
