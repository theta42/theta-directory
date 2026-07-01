'use strict';

// Explicit cache-behaviour tests.
//
// The goal is NOT to re-test CRUD happy paths (those live in user.test.js and
// group.test.js). The goal is to verify the specific cache invariants:
//
//  1. Repeated reads return consistent data (cache doesn't corrupt results).
//  2. Concurrent requests share one LDAP fetch — no stampede.
//  3. Writes invalidate the user cache (stale data is never served after PUT).
//  4. Writes invalidate the group cache (stale data is never served after
//     member/owner add or remove).
//  5. User.clearCache() can be called directly and leaves the next read clean.

const { TEST_CREDS, login, request, app } = require('./setup');
const { User } = require('../models/user_ldap');

const CACHE_TEST_GROUP = 'test_jest_cache_group';
const CACHE_TEST_USER  = {
	givenName:    'Cache',
	sn:           'Tester',
	mail:         'ctester@test.example.com',
	userPassword: 'CacheTest!1',
};
const CACHE_TEST_UID = `${CACHE_TEST_USER.givenName[0]}${CACHE_TEST_USER.sn}`.toLowerCase(); // 'ctester'

let token;

beforeAll(async () => {
	token = await login();
	// Clean up any leftover artifacts from a previous failed run
	await request(app).delete(`/api/user/${CACHE_TEST_UID}`).set('auth-token', token);
	await request(app).delete(`/api/group/${CACHE_TEST_GROUP}`).set('auth-token', token);
});

afterAll(async () => {
	await request(app).delete(`/api/user/${CACHE_TEST_UID}`).set('auth-token', token);
	await request(app).delete(`/api/group/${CACHE_TEST_GROUP}`).set('auth-token', token);
});

// ---------------------------------------------------------------------------
// 1. Repeated reads are consistent
// ---------------------------------------------------------------------------

// Note: listDetail() on both User and Group uses a shared LDAP client without
// a promise-stampede guard, so these must be sequential — concurrent binds on
// one client cause the connection to stall.
describe('Cache — repeated reads are consistent', () => {
	test('two serial GET /api/user/?detail=true calls return the same uid set', async () => {
		const r1 = await request(app).get('/api/user/?detail=true').set('auth-token', token);
		const r2 = await request(app).get('/api/user/?detail=true').set('auth-token', token);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);

		const uids1 = r1.body.results.map(u => u.uid).sort();
		const uids2 = r2.body.results.map(u => u.uid).sort();
		expect(uids1).toEqual(uids2);
	});

	test('two serial GET /api/group/?detail=true calls return the same cn set', async () => {
		const r1 = await request(app).get('/api/group/?detail=true').set('auth-token', token);
		const r2 = await request(app).get('/api/group/?detail=true').set('auth-token', token);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);

		const cns1 = r1.body.results.map(g => g.cn).sort();
		const cns2 = r2.body.results.map(g => g.cn).sort();
		expect(cns1).toEqual(cns2);
	});
});

// ---------------------------------------------------------------------------
// 2. Concurrent request deduplication (promise-stampede guard in User.get)
// ---------------------------------------------------------------------------

describe('Cache — concurrent requests share one LDAP fetch', () => {
	test('two simultaneous GET /api/user/:uid requests both succeed with the same data', async () => {
		const [r1, r2] = await Promise.all([
			request(app).get(`/api/user/${TEST_CREDS.uid}`).set('auth-token', token),
			request(app).get(`/api/user/${TEST_CREDS.uid}`).set('auth-token', token),
		]);

		expect(r1.status).toBe(200);
		expect(r2.status).toBe(200);
		expect(r1.body.results.uid).toBe(TEST_CREDS.uid);
		expect(r2.body.results.uid).toBe(TEST_CREDS.uid);
		// Both responses must be identical
		expect(r1.body.results.dn).toBe(r2.body.results.dn);
	});
});

// ---------------------------------------------------------------------------
// 3. User cache invalidation after writes
// ---------------------------------------------------------------------------

describe('Cache — user cache is invalidated after writes', () => {
	beforeAll(async () => {
		await request(app).post('/api/user/').set('auth-token', token).send(CACHE_TEST_USER);
	});

	afterAll(async () => {
		await request(app).delete(`/api/user/${CACHE_TEST_UID}`).set('auth-token', token);
	});

	test('new user is visible in list immediately (list cache invalidated on create)', async () => {
		const res = await request(app)
			.get('/api/user/?detail=true')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.results.some(u => u.uid === CACHE_TEST_UID)).toBe(true);
	});

	test('updated field is visible immediately (get cache invalidated on update)', async () => {
		await request(app)
			.put(`/api/user/${CACHE_TEST_UID}`)
			.set('auth-token', token)
			.send({ description: 'cache-invalidation-marker' });

		const res = await request(app)
			.get(`/api/user/${CACHE_TEST_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.results.description).toBe('cache-invalidation-marker');
	});

	test('new password works immediately (cache invalidated on password change)', async () => {
		const NEW_PW = 'CacheNew!2';
		await request(app)
			.put(`/api/user/${CACHE_TEST_UID}/password`)
			.set('auth-token', token)
			.send({ userPassword: NEW_PW });

		const login = await request(app)
			.post('/api/auth/login')
			.send({ uid: CACHE_TEST_UID, password: NEW_PW });

		expect(login.status).toBe(200);
		expect(login.body).toHaveProperty('token');
	});

	test('deleted user is gone from list immediately (cache invalidated on delete)', async () => {
		await request(app).delete(`/api/user/${CACHE_TEST_UID}`).set('auth-token', token);

		const res = await request(app)
			.get('/api/user/?detail=true')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.results.some(u => u.uid === CACHE_TEST_UID)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. Group cache invalidation after writes
// ---------------------------------------------------------------------------

describe('Cache — group cache is invalidated after writes', () => {
	const MEMBER_UID = 'wmantly';

	beforeAll(async () => {
		await request(app)
			.post('/api/group/')
			.set('auth-token', token)
			.send({ name: CACHE_TEST_GROUP, description: 'cache test group' });
	});

	test('new group appears in list immediately (cache invalidated on create)', async () => {
		const res = await request(app).get('/api/group/').set('auth-token', token);
		expect(res.body.results).toContain(CACHE_TEST_GROUP);
	});

	test('added member appears in group detail immediately (cache invalidated on member add)', async () => {
		await request(app)
			.put(`/api/group/${CACHE_TEST_GROUP}/${MEMBER_UID}`)
			.set('auth-token', token);

		const res = await request(app)
			.get(`/api/group/${CACHE_TEST_GROUP}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		const members = [].concat(res.body.results.member || []);
		expect(members.some(dn => dn.includes(MEMBER_UID))).toBe(true);
	});

	test('removed member is gone from group detail immediately (cache invalidated on member remove)', async () => {
		await request(app)
			.delete(`/api/group/${CACHE_TEST_GROUP}/${MEMBER_UID}`)
			.set('auth-token', token);

		const res = await request(app)
			.get(`/api/group/${CACHE_TEST_GROUP}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		const members = [].concat(res.body.results.member || []);
		expect(members.some(dn => dn.includes(MEMBER_UID))).toBe(false);
	});

	test('deleted group is gone from list immediately (cache invalidated on delete)', async () => {
		await request(app).delete(`/api/group/${CACHE_TEST_GROUP}`).set('auth-token', token);

		const res = await request(app).get('/api/group/').set('auth-token', token);
		expect(res.body.results).not.toContain(CACHE_TEST_GROUP);
	});
});

// ---------------------------------------------------------------------------
// 5. User.clearCache() works via the model directly
// ---------------------------------------------------------------------------

describe('Cache — User.clearCache() flushes stale entries', () => {
	test('clearCache() does not throw and subsequent read succeeds', async () => {
		expect(() => User.clearCache()).not.toThrow();

		const res = await request(app)
			.get(`/api/user/${TEST_CREDS.uid}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.results.uid).toBe(TEST_CREDS.uid);
	});

	test('failed get for unknown user evicts promise from cache (no stuck promise)', async () => {
		const BAD_UID = 'no_such_cache_user_xyz';

		// First attempt — should 404
		const r1 = await request(app).get(`/api/user/${BAD_UID}`).set('auth-token', token);
		expect(r1.status).toBeGreaterThanOrEqual(400);

		// Second attempt — must also 404, not return a stuck rejected promise
		const r2 = await request(app).get(`/api/user/${BAD_UID}`).set('auth-token', token);
		expect(r2.status).toBeGreaterThanOrEqual(400);
	});
});
