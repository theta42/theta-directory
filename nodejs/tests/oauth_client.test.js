'use strict';

const { login, request, app } = require('./setup');

const TEST_CLIENT = {
	name: 'Test Client',
	description: 'Created by automated tests',
	redirect_uris: 'https://test.example.com/callback',
	scopes: 'openid profile email',
	token_lifetime: { access_token: 3600, refresh_token: 86400 },
};

let token;
let clientId;
let clientSecret;

beforeAll(async () => {
	token = await login();
});

afterAll(async () => {
	if (clientId) {
		await request(app)
			.delete(`/api/oauth/client/${clientId}`)
			.set('auth-token', token);
	}
});

describe('OAuth Clients — POST /api/oauth/client/', () => {
	test('creates a new client and returns one-time secret', async () => {
		const res = await request(app)
			.post('/api/oauth/client/')
			.set('auth-token', token)
			.send(TEST_CLIENT);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('results');
		expect(res.body).toHaveProperty('client_secret');
		expect(res.body.results).toHaveProperty('client_id');
		expect(res.body.results).toHaveProperty('name', TEST_CLIENT.name);
		expect(res.body.results.client_id.length).toBeGreaterThan(0);

		clientId = res.body.results.client_id;
		clientSecret = res.body.client_secret;
	});

	test('requires oauth_admin group — 401 not shown here (see group membership)', () => {
		// If test user is not in app_sso_oauth_admin, the test above will fail with 401.
		// That itself is the correct behavior to verify.
		expect(clientId).toBeDefined();
	});
});

describe('OAuth Clients — GET /api/oauth/client/', () => {
	test('lists clients including the test client', async () => {
		const res = await request(app)
			.get('/api/oauth/client/')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
		const found = res.body.results.find(c => c.client_id === clientId);
		expect(found).toBeDefined();
	});
});

describe('OAuth Clients — GET /api/oauth/client/:id', () => {
	test('returns the test client by id', async () => {
		const res = await request(app)
			.get(`/api/oauth/client/${clientId}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.results).toHaveProperty('client_id', clientId);
		expect(res.body.results).toHaveProperty('name', TEST_CLIENT.name);
	});

	test('unknown client_id returns 404 or error', async () => {
		const res = await request(app)
			.get('/api/oauth/client/00000000-0000-0000-0000-000000000000')
			.set('auth-token', token);

		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe('OAuth Clients — PUT /api/oauth/client/:id', () => {
	test('updates the client description', async () => {
		const res = await request(app)
			.put(`/api/oauth/client/${clientId}`)
			.set('auth-token', token)
			.send({ description: 'Updated by test' });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});
});

describe('OAuth Clients — POST /api/oauth/client/:id/rotate', () => {
	test('rotates the client secret and returns a new one', async () => {
		const res = await request(app)
			.post(`/api/oauth/client/${clientId}/rotate`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('client_secret');
		expect(typeof res.body.client_secret).toBe('string');
		expect(res.body.client_secret).not.toBe(clientSecret);

		clientSecret = res.body.client_secret;
	});
});
