'use strict';

const { TEST_CREDS, login, request, app } = require('./setup');

// Derived uid: givenName[0] + sn, lowercased → 'jrunner'
const TEST_USER = {
	givenName: 'Jest',
	sn: 'Runner',
	mail: 'jrunner@test.example.com',
	mobile: '5555551234',
	userPassword: 'TestPass!99',
};
const TEST_UID = `${TEST_USER.givenName[0]}${TEST_USER.sn}`.toLowerCase(); // 'jrunner'

let token;

beforeAll(async () => {
	token = await login();
	// Clean up any leftover test user from a previous failed run
	await request(app).delete(`/api/user/${TEST_UID}`).set('auth-token', token);
});

afterAll(async () => {
	await request(app).delete(`/api/user/${TEST_UID}`).set('auth-token', token);
});

describe('Users — GET /api/user/', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/user/');
		expect(res.status).toBe(401);
	});

	test('returns user list for admin', async () => {
		const res = await request(app)
			.get('/api/user/?detail=true')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
	});

	test('result entries have expected LDAP fields', async () => {
		const res = await request(app)
			.get('/api/user/?detail=true')
			.set('auth-token', token);

		const user = res.body.results.find(u => u.uid === TEST_CREDS.uid);
		expect(user).toBeDefined();
		expect(user).toHaveProperty('uid', TEST_CREDS.uid);
		expect(user).toHaveProperty('dn');
		expect(user).toHaveProperty('mail');
	});
});

describe('Users — GET /api/user/:uid', () => {
	test('returns a single user', async () => {
		const res = await request(app)
			.get(`/api/user/${TEST_CREDS.uid}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.results).toHaveProperty('uid', TEST_CREDS.uid);
	});

	test('unknown uid returns error', async () => {
		const res = await request(app)
			.get('/api/user/no_such_user_xyz')
			.set('auth-token', token);

		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe('Users — POST /api/user/ (create)', () => {
	test('creates a new user', async () => {
		const res = await request(app)
			.post('/api/user/')
			.set('auth-token', token)
			.send(TEST_USER);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('results');
		expect(res.body.results).toHaveProperty('uid', TEST_UID);
	});

	test('new user appears in list', async () => {
		const res = await request(app)
			.get('/api/user/?detail=true')
			.set('auth-token', token);

		const found = res.body.results.find(u => u.uid === TEST_UID);
		expect(found).toBeDefined();
	});

	test('requires admin — 401 without membership', async () => {
		// Verify the endpoint is gated (tested implicitly: no-token case)
		const res = await request(app)
			.post('/api/user/')
			.send(TEST_USER);
		expect(res.status).toBe(401);
	});
});

describe('Users — PUT /api/user/:uid (update)', () => {
	test('admin can update another user', async () => {
		const res = await request(app)
			.put(`/api/user/${TEST_UID}`)
			.set('auth-token', token)
			.send({ description: 'Updated by test suite' });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});

	test('user can update their own profile', async () => {
		// Log in as the test user created above
		const userToken = (await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: TEST_USER.userPassword })).body.token;

		const res = await request(app)
			.put(`/api/user/${TEST_UID}`)
			.set('auth-token', userToken)
			.send({ mobile: '5555559999' });

		expect(res.status).toBe(200);
	});
});

describe('Users — password self-service', () => {
	const NEW_PASSWORD = 'NewPass!88';

	test('PUT /api/user/:uid/password — admin changes another user\'s password', async () => {
		const res = await request(app)
			.put(`/api/user/${TEST_UID}/password`)
			.set('auth-token', token)
			.send({ userPassword: NEW_PASSWORD });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});

	test('new password works for login', async () => {
		const res = await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: NEW_PASSWORD });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
	});

	test('PUT /api/user/password — user changes own password', async () => {
		const userToken = (await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: NEW_PASSWORD })).body.token;

		const res = await request(app)
			.put('/api/user/password')
			.set('auth-token', userToken)
			.send({ userPassword: 'SelfSet!77' });

		expect(res.status).toBe(200);
	});

	test('self-set password works for login', async () => {
		const res = await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: 'SelfSet!77' });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
	});
});

describe('Users — DELETE /api/user/:uid', () => {
	test('admin can delete a user', async () => {
		const res = await request(app)
			.delete(`/api/user/${TEST_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('uid', TEST_UID);
	});

	test('deleted user no longer appears in list', async () => {
		const res = await request(app)
			.get('/api/user/?detail=true')
			.set('auth-token', token);

		const found = res.body.results.find(u => u.uid === TEST_UID);
		expect(found).toBeUndefined();
	});

	test('deleted user cannot log in', async () => {
		const res = await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: 'SelfSet!77' });

		expect(res.status).toBe(401);
	});
});
