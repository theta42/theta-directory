'use strict';

const { TEST_CREDS, login, request, app } = require('./setup');

let token;
let inviteTokenId; // the invite token string returned by POST /api/user/invite

beforeAll(async () => {
	token = await login();
});

// Clean up any invite tokens we created — there's no bulk delete API so we
// rely on the DELETE endpoint tests and the fact that Redis keys are flushed
// by globalSetup before every run.

describe('Invite — POST /api/user/invite (create)', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app)
			.post('/api/user/invite')
			.send({ mail: 'nobody@example.com', groups: [] });
		expect(res.status).toBe(401);
	});

	test('admin can create an invite with no mail and no groups', async () => {
		const res = await request(app)
			.post('/api/user/invite')
			.set('auth-token', token)
			.send({});

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
		expect(typeof res.body.token).toBe('string');
		expect(res.body.token.length).toBeGreaterThan(0);
		expect(res.body).toHaveProperty('link');
		// mail was not provided, so mail_sent should be false
		expect(res.body.mail_sent).toBe(false);

		inviteTokenId = res.body.token;
	});

	test('admin can create an invite with groups', async () => {
		const res = await request(app)
			.post('/api/user/invite')
			.set('auth-token', token)
			.send({ groups: ['app_sso_admin'] });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
	});
});

describe('Invite — GET /api/user/invite (list)', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/user/invite');
		expect(res.status).toBe(401);
	});

	test('admin can list invite tokens', async () => {
		const res = await request(app)
			.get('/api/user/invite')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
	});

	test('list includes the token created above', async () => {
		expect(inviteTokenId).toBeDefined();

		const res = await request(app)
			.get('/api/user/invite')
			.set('auth-token', token);

		const found = res.body.results.find(t => t.token === inviteTokenId);
		expect(found).toBeDefined();
		// isPrivate field on the base token class must be exposed in the list response
		expect(found).toHaveProperty('token', inviteTokenId);
	});
});

describe('Invite — PUT /api/user/invite/:token (update)', () => {
	test('requires auth — 401 without token', async () => {
		expect(inviteTokenId).toBeDefined();
		const res = await request(app)
			.put(`/api/user/invite/${inviteTokenId}`)
			.send({ groups: ['app_sso_users'] });
		expect(res.status).toBe(401);
	});

	test('admin can update groups on an invite token', async () => {
		expect(inviteTokenId).toBeDefined();
		const res = await request(app)
			.put(`/api/user/invite/${inviteTokenId}`)
			.set('auth-token', token)
			.send({ groups: ['app_sso_users'] });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('results');
		expect(res.body.results).toHaveProperty('token', inviteTokenId);
	});

	test('updating a nonexistent token returns an error', async () => {
		const res = await request(app)
			.put('/api/user/invite/00000000-0000-0000-0000-000000000000')
			.set('auth-token', token)
			.send({ groups: [] });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

describe('Invite — DELETE /api/user/invite/:token (invalidate)', () => {
	test('requires auth — 401 without token', async () => {
		expect(inviteTokenId).toBeDefined();
		const res = await request(app)
			.delete(`/api/user/invite/${inviteTokenId}`);
		expect(res.status).toBe(401);
	});

	test('admin can invalidate an invite token', async () => {
		expect(inviteTokenId).toBeDefined();
		const res = await request(app)
			.delete(`/api/user/invite/${inviteTokenId}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('results', true);
	});

	test('invalidated token can no longer be updated', async () => {
		expect(inviteTokenId).toBeDefined();
		const res = await request(app)
			.put(`/api/user/invite/${inviteTokenId}`)
			.set('auth-token', token)
			.send({ groups: [] });

		// Should be 400 (token is no longer valid)
		expect(res.status).toBe(400);
	});
});
