'use strict';

const { TEST_CREDS, login, request, app } = require('./setup');

const TEST_GROUP = {
	name: 'test_jest_group',
	description: 'Created by automated test suite',
};

let token;
let firstGroupCN;

beforeAll(async () => {
	token = await login();
	// Clean up any leftover group from a previous failed run
	await request(app).delete(`/api/group/${TEST_GROUP.name}`).set('auth-token', token);
});

afterAll(async () => {
	await request(app).delete(`/api/group/${TEST_GROUP.name}`).set('auth-token', token);
});

describe('Groups — GET /api/group/', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/group/');
		expect(res.status).toBe(401);
	});

	test('returns group list for authenticated user', async () => {
		const res = await request(app)
			.get('/api/group/')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
		expect(res.body.results.length).toBeGreaterThan(0);

		firstGroupCN = res.body.results[0];
	});

	test('detail=true returns full group objects', async () => {
		const res = await request(app)
			.get('/api/group/?detail=true')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		const group = res.body.results[0];
		expect(group).toHaveProperty('cn');
		expect(group).toHaveProperty('dn');
		expect(group).toHaveProperty('description');
	});
});

describe('Groups — GET /api/group/:cn', () => {
	test('returns a single group by cn', async () => {
		const res = await request(app)
			.get(`/api/group/${firstGroupCN}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.results).toHaveProperty('cn', firstGroupCN);
	});

	test('unknown cn returns an error', async () => {
		const res = await request(app)
			.get('/api/group/no_such_group_xyz')
			.set('auth-token', token);

		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe('Groups — POST /api/group/ (create)', () => {
	test('creates a new group', async () => {
		const res = await request(app)
			.post('/api/group/')
			.set('auth-token', token)
			.send(TEST_GROUP);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
		expect(res.body.message).toMatch(TEST_GROUP.name);
	});

	test('new group appears in list', async () => {
		const res = await request(app)
			.get('/api/group/')
			.set('auth-token', token);

		expect(res.body.results).toContain(TEST_GROUP.name);
	});

	test('requires admin — 401 without token', async () => {
		const res = await request(app)
			.post('/api/group/')
			.send(TEST_GROUP);

		expect(res.status).toBe(401);
	});
});

// groupOfNames requires at least one member. The creator (test) is auto-added.
// We test add/remove with a second known LDAP user to avoid the last-member constraint.
const MEMBER_UID = 'wmantly';

describe('Groups — member management', () => {
	test('creator is already a member after group creation', async () => {
		const res = await request(app)
			.get(`/api/group/${TEST_GROUP.name}`)
			.set('auth-token', token);

		const group = res.body.results;
		const members = Array.isArray(group.member) ? group.member : [group.member];
		expect(members.some(dn => dn && dn.includes(TEST_CREDS.uid))).toBe(true);
	});

	test('PUT /:group/:uid — add second member', async () => {
		const res = await request(app)
			.put(`/api/group/${TEST_GROUP.name}/${MEMBER_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});

	test('second member appears in group detail', async () => {
		const res = await request(app)
			.get(`/api/group/${TEST_GROUP.name}`)
			.set('auth-token', token);

		const group = res.body.results;
		const members = Array.isArray(group.member) ? group.member : [group.member];
		expect(members.some(dn => dn && dn.includes(MEMBER_UID))).toBe(true);
	});

	test('DELETE /:group/:uid — remove second member', async () => {
		const res = await request(app)
			.delete(`/api/group/${TEST_GROUP.name}/${MEMBER_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});

	test('second member no longer in group after removal', async () => {
		const res = await request(app)
			.get(`/api/group/${TEST_GROUP.name}`)
			.set('auth-token', token);

		const group = res.body.results;
		const members = Array.isArray(group.member) ? group.member : [group.member];
		expect(members.some(dn => dn && dn.includes(MEMBER_UID))).toBe(false);
	});
});

describe('Groups — owner management', () => {
	test('PUT /owner/:group/:uid — add second owner', async () => {
		const res = await request(app)
			.put(`/api/group/owner/${TEST_GROUP.name}/${MEMBER_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});

	test('second owner appears in group detail', async () => {
		const res = await request(app)
			.get(`/api/group/${TEST_GROUP.name}`)
			.set('auth-token', token);

		const group = res.body.results;
		const owners = Array.isArray(group.owner) ? group.owner : [group.owner];
		expect(owners.some(dn => dn && dn.includes(MEMBER_UID))).toBe(true);
	});

	test('DELETE /owner/:group/:uid — remove second owner', async () => {
		const res = await request(app)
			.delete(`/api/group/owner/${TEST_GROUP.name}/${MEMBER_UID}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});
});

describe('Groups — DELETE /api/group/:cn', () => {
	test('deletes the test group', async () => {
		const res = await request(app)
			.delete(`/api/group/${TEST_GROUP.name}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
		expect(res.body.message).toMatch(TEST_GROUP.name);
	});

	test('group no longer appears in list', async () => {
		const res = await request(app)
			.get('/api/group/')
			.set('auth-token', token);

		expect(res.body.results).not.toContain(TEST_GROUP.name);
	});
});
