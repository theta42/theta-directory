'use strict';

const { TEST_CREDS, login, request, app } = require('./setup');

// Target an existing user that is NOT the admin (wmantly is always present in the test LDAP)
const TARGET_UID = 'wmantly';

let token;

beforeAll(async () => {
	token = await login();
	// Clean up any leftover impersonation from a previous run
	await request(app).delete(`/api/auth/impersonate/${TARGET_UID}`).set('auth-token', token);
});

afterAll(async () => {
	await request(app).delete(`/api/auth/impersonate/${TARGET_UID}`).set('auth-token', token);
});

describe('Impersonation — POST /api/auth/impersonate/:uid', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).post(`/api/auth/impersonate/${TARGET_UID}`);
		expect(res.status).toBe(401);
	});

	test('admin can create impersonation and receives temp credentials', async () => {
		const res = await request(app)
			.post(`/api/auth/impersonate/${TARGET_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('uid', TARGET_UID);
		expect(res.body).toHaveProperty('temp_password');
		expect(res.body).toHaveProperty('expires_at');
		expect(typeof res.body.temp_password).toBe('string');
		expect(res.body.temp_password.length).toBeGreaterThan(8);
	});

	test('temp password works for LDAP login', async () => {
		// Create fresh impersonation to get the temp password
		const impRes = await request(app)
			.post(`/api/auth/impersonate/${TARGET_UID}`)
			.set('auth-token', token);

		const tempPassword = impRes.body.temp_password;

		const loginRes = await request(app)
			.post('/api/auth/login')
			.send({ uid: TARGET_UID, password: tempPassword });

		expect(loginRes.status).toBe(200);
		expect(loginRes.body).toHaveProperty('token');
	});

	test('rejects unknown uid', async () => {
		const res = await request(app)
			.post('/api/auth/impersonate/no_such_user_xyz')
			.set('auth-token', token);

		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe('Impersonation — DELETE /api/auth/impersonate/:uid', () => {
	test('admin can revoke impersonation', async () => {
		const res = await request(app)
			.delete(`/api/auth/impersonate/${TARGET_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});

	test('temp password no longer works after revocation', async () => {
		// Create a fresh one, capture the password, revoke, then try login
		const impRes = await request(app)
			.post(`/api/auth/impersonate/${TARGET_UID}`)
			.set('auth-token', token);
		const tempPassword = impRes.body.temp_password;

		await request(app)
			.delete(`/api/auth/impersonate/${TARGET_UID}`)
			.set('auth-token', token);

		const loginRes = await request(app)
			.post('/api/auth/login')
			.send({ uid: TARGET_UID, password: tempPassword });

		expect(loginRes.status).toBe(401);
	});
});
