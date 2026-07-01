'use strict';

// Tests for admin-only user endpoints:
//   GET /api/user/stats
//   GET /api/user/export
//   GET /api/user/me
//   PUT /api/user/:uid/active

const { TEST_CREDS, login, request, app } = require('./setup');

// TEST_USER mirrors the user created in user.test.js — use a different uid so
// this suite is independent.
const TEST_USER = {
	givenName: 'Admin',
	sn: 'Tester',
	mail: 'atester@test.example.com',
	mobile: '5555550001',
	userPassword: 'AdminTest!55',
};
const TEST_UID = `${TEST_USER.givenName[0]}${TEST_USER.sn}`.toLowerCase(); // 'atester'

let token;

beforeAll(async () => {
	token = await login();
	// Clean up any leftover from a previous run
	await request(app).delete(`/api/user/${TEST_UID}`).set('auth-token', token);
	// Create the test user
	await request(app).post('/api/user/').set('auth-token', token).send(TEST_USER);
});

afterAll(async () => {
	await request(app).delete(`/api/user/${TEST_UID}`).set('auth-token', token);
});

describe('Users — GET /api/user/stats (admin only)', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/user/stats');
		expect(res.status).toBe(401);
	});

	test('returns aggregated counts for admin', async () => {
		const res = await request(app)
			.get('/api/user/stats')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('totalUsers');
		expect(res.body).toHaveProperty('activeUsers');
		expect(res.body).toHaveProperty('inactiveUsers');
		expect(res.body).toHaveProperty('totalGroups');
		expect(res.body).toHaveProperty('recentSignups');
		expect(res.body).toHaveProperty('inactiveList');
		expect(typeof res.body.totalUsers).toBe('number');
		expect(typeof res.body.totalGroups).toBe('number');
		expect(Array.isArray(res.body.recentSignups)).toBe(true);
		expect(Array.isArray(res.body.inactiveList)).toBe(true);
	});

	test('totalUsers is positive (at least the test user and admin exist)', async () => {
		const res = await request(app)
			.get('/api/user/stats')
			.set('auth-token', token);

		expect(res.body.totalUsers).toBeGreaterThan(0);
	});

	test('activeUsers + inactiveUsers equals totalUsers', async () => {
		const res = await request(app)
			.get('/api/user/stats')
			.set('auth-token', token);

		expect(res.body.activeUsers + res.body.inactiveUsers).toBe(res.body.totalUsers);
	});
});

describe('Users — GET /api/user/export (admin only)', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/user/export');
		expect(res.status).toBe(401);
	});

	test('returns CSV content for admin', async () => {
		const res = await request(app)
			.get('/api/user/export')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toMatch(/text\/csv/);
		expect(res.headers['content-disposition']).toMatch(/users\.csv/);
	});

	test('CSV has header row with expected columns', async () => {
		const res = await request(app)
			.get('/api/user/export')
			.set('auth-token', token);

		const lines = res.text.split('\n');
		const header = lines[0];
		expect(header).toContain('uid');
		expect(header).toContain('mail');
		expect(header).toContain('givenName');
		expect(header).toContain('sn');
	});

	test('CSV contains at least one data row', async () => {
		const res = await request(app)
			.get('/api/user/export')
			.set('auth-token', token);

		const lines = res.text.split('\n').filter(l => l.trim());
		// header + at least one user row
		expect(lines.length).toBeGreaterThan(1);
	});
});

describe('Users — GET /api/user/me', () => {
	test('returns the authenticated user\'s own profile', async () => {
		const res = await request(app)
			.get('/api/user/me')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		// The /me route returns User.get() directly (no results wrapper in some implementations)
		// Accept either shape
		const user = res.body.results || res.body;
		expect(user).toHaveProperty('uid', TEST_CREDS.uid);
	});

	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/user/me');
		expect(res.status).toBe(401);
	});
});

describe('Users — PUT /api/user/:uid/active (activate/deactivate)', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app)
			.put(`/api/user/${TEST_UID}/active`)
			.send({ active: false });
		expect(res.status).toBe(401);
	});

	test('admin can deactivate a user (skipped if ppolicy overlay not configured)', async () => {
		const res = await request(app)
			.put(`/api/user/${TEST_UID}/active`)
			.set('auth-token', token)
			.send({ active: false });

		// 503 means the OpenLDAP ppolicy overlay is not set up in this environment
		if (res.status === 503) return;

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('uid', TEST_UID);
		expect(res.body).toHaveProperty('active', false);
		expect(res.body).toHaveProperty('message');
	});

	test('deactivated user cannot log in (skipped if ppolicy overlay not configured)', async () => {
		// Check whether deactivation works in this environment first
		const checkRes = await request(app)
			.put(`/api/user/${TEST_UID}/active`)
			.set('auth-token', token)
			.send({ active: false });
		if (checkRes.status === 503) return;

		const res = await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: TEST_USER.userPassword });

		// LDAP may return 401 or 403 for locked accounts
		expect(res.status).toBeGreaterThanOrEqual(400);

		// Re-activate so cleanup works
		await request(app)
			.put(`/api/user/${TEST_UID}/active`)
			.set('auth-token', token)
			.send({ active: true });
	});

	test('admin can reactivate a user (skipped if ppolicy overlay not configured)', async () => {
		// First deactivate (may not be supported)
		const deactivateRes = await request(app)
			.put(`/api/user/${TEST_UID}/active`)
			.set('auth-token', token)
			.send({ active: false });
		if (deactivateRes.status === 503) return;

		const res = await request(app)
			.put(`/api/user/${TEST_UID}/active`)
			.set('auth-token', token)
			.send({ active: true });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('active', true);
	});
});
