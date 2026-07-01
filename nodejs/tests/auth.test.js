'use strict';

const { TEST_CREDS, login, request, app } = require('./setup');

describe('Auth — POST /api/auth/login', () => {
	test('valid credentials return a token', async () => {
		const res = await request(app)
			.post('/api/auth/login')
			.send(TEST_CREDS);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
		expect(typeof res.body.token).toBe('string');
		expect(res.body.token.length).toBeGreaterThan(0);
	});

	test('wrong password returns 401', async () => {
		const res = await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_CREDS.uid, password: 'wrongpassword' });

		expect(res.status).toBe(401);
	});

	test('unknown user returns 401', async () => {
		const res = await request(app)
			.post('/api/auth/login')
			.send({ uid: 'no_such_user_xyz', password: 'whatever' });

		expect(res.status).toBe(401);
	});

	test('missing body fields returns an error', async () => {
		const res = await request(app)
			.post('/api/auth/login')
			.send({});

		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe('Auth — POST /api/auth/logout', () => {
	test('logout with a valid token returns 200', async () => {
		const token = await login();
		const res = await request(app)
			.post('/api/auth/logout')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});

	test('logout without a token still returns 200', async () => {
		const res = await request(app).post('/api/auth/logout');
		expect(res.status).toBe(200);
	});
});
