'use strict';

// LDAP-over-HTTPS API (DESIGN.md §3). Exercises caller auth (agent token vs
// PAT), the bind flow against the real test OpenLDAP, and the agent-only search
// restriction.

const { TEST_CREDS, request, app } = require('./setup');
const { Agent } = require('../models/agent');
const { ApiToken } = require('../models/api_token');

async function enrollAgent() {
	const { agent, token } = await Agent.enroll({
		name: `ldap-test-${Date.now().toString(36)}`,
		description: 'api_ldap test agent',
		enrolledBy: 'test'
	});
	return { agent, token };
}

async function makePat() {
	const token = await ApiToken.add({
		name: 'ldap-test-pat',
		description: 'api_ldap test',
		created_by: 'test'
	});
	return token._raw_token;
}

describe('LDAP-over-HTTPS — POST /api/v1/ldap/bind', () => {
	test('valid credentials return the bound DN', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/ldap/bind')
			.set('Authorization', `Bearer ${token}`)
			.send({ username: TEST_CREDS.uid, password: TEST_CREDS.password });

		expect(res.status).toBe(200);
		expect(res.body.status).toBe('ok');
		expect(res.body.uid).toBe(TEST_CREDS.uid);
		expect(res.body.dn).toContain(TEST_CREDS.uid);
	});

	test('wrong password returns 401', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/ldap/bind')
			.set('Authorization', `Bearer ${token}`)
			.send({ username: TEST_CREDS.uid, password: 'wrong-password' });

		expect(res.status).toBe(401);
	});

	test('unknown user returns 401 (no existence oracle)', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/ldap/bind')
			.set('Authorization', `Bearer ${token}`)
			.send({ username: 'no_such_user_xyz', password: 'whatever' });

		expect(res.status).toBe(401);
	});

	test('a PAT caller can bind', async () => {
		const pat = await makePat();
		const res = await request(app)
			.post('/api/v1/ldap/bind')
			.set('Authorization', `Bearer ${pat}`)
			.send({ username: TEST_CREDS.uid, password: TEST_CREDS.password });

		expect(res.status).toBe(200);
	});

	test('no bearer token returns 401', async () => {
		const res = await request(app)
			.post('/api/v1/ldap/bind')
			.send({ username: TEST_CREDS.uid, password: TEST_CREDS.password });

		expect(res.status).toBe(401);
	});

	test('missing username/password returns 400', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/ldap/bind')
			.set('Authorization', `Bearer ${token}`)
			.send({ username: TEST_CREDS.uid });

		expect(res.status).toBe(400);
	});
});

describe('LDAP-over-HTTPS — POST /api/v1/ldap/search', () => {
	test('an agent can search the user tree', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/ldap/search')
			.set('Authorization', `Bearer ${token}`)
			.send({ filter: `(uid=${TEST_CREDS.uid})`, attributes: ['uid', 'cn'] });

		expect(res.status).toBe(200);
		expect(res.body.status).toBe('ok');
		expect(Array.isArray(res.body.entries)).toBe(true);
		expect(res.body.entries.length).toBeGreaterThan(0);
		expect(res.body.entries[0].uid).toBe(TEST_CREDS.uid);
	});

	test('a PAT caller is denied search (agent-only)', async () => {
		const pat = await makePat();
		const res = await request(app)
			.post('/api/v1/ldap/search')
			.set('Authorization', `Bearer ${pat}`)
			.send({ filter: `(uid=${TEST_CREDS.uid})` });

		expect(res.status).toBe(403);
	});

	test('missing filter returns 400', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/ldap/search')
			.set('Authorization', `Bearer ${token}`)
			.send({});

		expect(res.status).toBe(400);
	});
});
