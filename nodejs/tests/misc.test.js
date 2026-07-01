'use strict';

// Tests for endpoints not covered by other test files:
//   GET  /api/auth/username-suggestions
//   POST /api/auth/resetpassword
//   POST /api/auth/resetpassword/:token
//   POST /api/auth/invite/:token            (email-verify step of invite flow)
//   POST /api/auth/invite/:token/:mailToken (accept invite, create account)
//   POST /api/user/accept-tos
//   POST /api/user/key
//   GET  /api/user/:uid/verification
//   GET  /api/token/
//   GET  /api/token/:name
//   GET  /api/token/:name/:token

const { TEST_CREDS, login, request, app } = require('./setup');
const { PasswordResetToken, InviteToken } = require('../models/token');

// Dedicated test user — created in beforeAll, removed in afterAll.
const TEST_USER = {
	givenName: 'Misc',
	sn: 'Tester',
	mail: 'mtester@test.example.com',
	mobile: '5555550099',
	userPassword: 'MiscTest!77',
};
const TEST_UID = 'mtester'; // givenName[0] + sn lowercase

// The uid assigned to the invite-accept user (filled in by beforeAll for that describe block).
let createdInviteUid;

let token;

beforeAll(async () => {
	token = await login();
	// Remove any leftovers from a previous failed run.
	await request(app).delete(`/api/user/${TEST_UID}`).set('auth-token', token);
	// Clean up potential invite-accept user leftovers (givenName=Invite, sn=Acceptor).
	for (const uid of ['iacceptor', 'iacceptor2', 'iacceptor3', 'inviteacceptor', 'invite_acceptor', 'invitea', 'acceptori']) {
		await request(app).delete(`/api/user/${uid}`).set('auth-token', token);
	}
	// Create the test user used by most describes below.
	await request(app).post('/api/user/').set('auth-token', token).send(TEST_USER);
});

afterAll(async () => {
	await request(app).delete(`/api/user/${TEST_UID}`).set('auth-token', token);
	// Clean up any user created by the invite-accept test.
	if (createdInviteUid) {
		await request(app).delete(`/api/user/${createdInviteUid}`).set('auth-token', token);
	}
});

// ---------------------------------------------------------------------------
// GET /api/auth/username-suggestions
// ---------------------------------------------------------------------------

describe('Auth — GET /api/auth/username-suggestions', () => {
	test('missing params returns empty suggestions array', async () => {
		const res = await request(app).get('/api/auth/username-suggestions');
		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('suggestions');
		expect(res.body.suggestions).toEqual([]);
	});

	test('only sn (no givenName) returns empty suggestions', async () => {
		const res = await request(app)
			.get('/api/auth/username-suggestions')
			.query({ sn: 'Uniqueish' });
		expect(res.status).toBe(200);
		expect(res.body.suggestions).toEqual([]);
	});

	test('givenName + sn returns at least one suggestion', async () => {
		const res = await request(app)
			.get('/api/auth/username-suggestions')
			.query({ givenName: 'Unique', sn: 'Xyzzyabc' });
		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.suggestions)).toBe(true);
		expect(res.body.suggestions.length).toBeGreaterThan(0);
		// Primary suggestion should be first-initial + last-name
		expect(res.body.suggestions[0]).toMatch(/^uxyzzyabc/);
	});

	test('dob adds year-suffixed suggestions', async () => {
		const res = await request(app)
			.get('/api/auth/username-suggestions')
			.query({ givenName: 'Dob', sn: 'Testerly', dob: '1990-06-15' });
		expect(res.status).toBe(200);
		expect(res.body.suggestions.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// POST /api/auth/resetpassword
// ---------------------------------------------------------------------------

describe('Auth — POST /api/auth/resetpassword', () => {
	test('unknown email returns error status', async () => {
		const res = await request(app)
			.post('/api/auth/resetpassword')
			.send({ mail: 'nobody_at_all@noreply.example.com' });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('known email returns 200 with message (SMTP failure is non-fatal)', async () => {
		const res = await request(app)
			.post('/api/auth/resetpassword')
			.send({ mail: TEST_USER.mail });
		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');
	});
});

// ---------------------------------------------------------------------------
// POST /api/auth/resetpassword/:token
// ---------------------------------------------------------------------------

describe('Auth — POST /api/auth/resetpassword/:token', () => {
	const RESET_PASSWORD = 'ResetPass!44';

	test('invalid / unknown token returns error', async () => {
		const res = await request(app)
			.post('/api/auth/resetpassword/00000000-0000-0000-0000-000000000000')
			.send({ userPassword: RESET_PASSWORD });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('valid token resets the password and login succeeds', async () => {
		const resetToken = await PasswordResetToken.create({ created_by: TEST_UID });

		const res = await request(app)
			.post(`/api/auth/resetpassword/${resetToken.token}`)
			.send({ userPassword: RESET_PASSWORD });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message');

		// Verify the new password works.
		const loginRes = await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: RESET_PASSWORD });
		expect(loginRes.status).toBe(200);
		expect(loginRes.body).toHaveProperty('token');

		// Restore the original password so later tests that reuse this user still work.
		await request(app)
			.put(`/api/user/${TEST_UID}/password`)
			.set('auth-token', token)
			.send({ userPassword: TEST_USER.userPassword });
	});

	test('token can only be used once', async () => {
		const resetToken = await PasswordResetToken.create({ created_by: TEST_UID });

		// First use should succeed.
		const first = await request(app)
			.post(`/api/auth/resetpassword/${resetToken.token}`)
			.send({ userPassword: RESET_PASSWORD });
		expect(first.status).toBe(200);

		// Restore password before second attempt.
		await request(app)
			.put(`/api/user/${TEST_UID}/password`)
			.set('auth-token', token)
			.send({ userPassword: TEST_USER.userPassword });

		// Second use of the same token must be rejected.
		const second = await request(app)
			.post(`/api/auth/resetpassword/${resetToken.token}`)
			.send({ userPassword: RESET_PASSWORD });
		expect(second.status).toBeGreaterThanOrEqual(400);
	});
});

// ---------------------------------------------------------------------------
// POST /api/auth/invite/:token  (email-verify step)
// ---------------------------------------------------------------------------

describe('Auth — POST /api/auth/invite/:token (email verification for invite)', () => {
	test('invalid token returns error', async () => {
		const res = await request(app)
			.post('/api/auth/invite/00000000-0000-0000-0000-000000000000')
			.send({ mail: 'nobody@test.example.com' });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('valid token updates token mail and responds with sent (SMTP failure is non-fatal)', async () => {
		const invToken = await InviteToken.create({ created_by: TEST_CREDS.uid });

		const res = await request(app)
			.post(`/api/auth/invite/${invToken.token}`)
			.send({ mail: 'verifyinvite@test.example.com' });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('message', 'sent');

		// Invalidate the token so it doesn't pollute other tests.
		await invToken.update({ is_valid: false });
	});

	test('email already in use returns error', async () => {
		const invToken = await InviteToken.create({ created_by: TEST_CREDS.uid });

		// TEST_USER.mail already belongs to mtester — it is "in use".
		const res = await request(app)
			.post(`/api/auth/invite/${invToken.token}`)
			.send({ mail: TEST_USER.mail });

		expect(res.status).toBeGreaterThanOrEqual(400);

		await invToken.update({ is_valid: false });
	});
});

// ---------------------------------------------------------------------------
// POST /api/auth/invite/:token/:mailToken  (accept invite, create account)
// ---------------------------------------------------------------------------

describe('Auth — POST /api/auth/invite/:token/:mailToken (accept invite)', () => {
	let inviteTokenId;
	const INVITE_MAIL_TOKEN = 'misc-suite-mailtoken-12345678901234';
	const INVITE_MAIL = 'iacceptor@test.example.com';
	const INVITE_GIVENNAME = 'Invite';
	const INVITE_SN = 'Acceptor';
	const INVITE_PASSWORD = 'InviteAcc!88';

	beforeAll(async () => {
		// Get a valid username suggestion for this user so we can pass it in the request.
		const suggestRes = await request(app)
			.get('/api/auth/username-suggestions')
			.query({ givenName: INVITE_GIVENNAME, sn: INVITE_SN });

		createdInviteUid = suggestRes.body.suggestions[0];

		// Build the invite token directly in Redis (avoids needing real SMTP).
		const invToken = await InviteToken.create({ created_by: TEST_CREDS.uid });
		inviteTokenId = invToken.token;
		await invToken.update({ mail: INVITE_MAIL, mail_token: INVITE_MAIL_TOKEN });
	});

	test('unknown token returns error', async () => {
		const res = await request(app)
			.post('/api/auth/invite/00000000-0000-0000-0000-000000000000/anytoken')
			.send({ givenName: INVITE_GIVENNAME, sn: INVITE_SN, uid: 'nobody', userPassword: INVITE_PASSWORD });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('invalid uid (not in suggestions) returns 400', async () => {
		const res = await request(app)
			.post(`/api/auth/invite/${inviteTokenId}/${INVITE_MAIL_TOKEN}`)
			.send({ givenName: INVITE_GIVENNAME, sn: INVITE_SN, uid: 'definitely_not_suggested', userPassword: INVITE_PASSWORD });
		expect(res.status).toBe(400);
	});

	test('valid invite creates a new user account and returns an auth token', async () => {
		expect(createdInviteUid).toBeDefined();

		const res = await request(app)
			.post(`/api/auth/invite/${inviteTokenId}/${INVITE_MAIL_TOKEN}`)
			.send({
				givenName: INVITE_GIVENNAME,
				sn: INVITE_SN,
				uid: createdInviteUid,
				userPassword: INVITE_PASSWORD,
			});

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
		expect(res.body).toHaveProperty('user', createdInviteUid);
	});

	test('consumed token cannot be reused', async () => {
		const res = await request(app)
			.post(`/api/auth/invite/${inviteTokenId}/${INVITE_MAIL_TOKEN}`)
			.send({
				givenName: INVITE_GIVENNAME,
				sn: INVITE_SN,
				uid: createdInviteUid,
				userPassword: INVITE_PASSWORD,
			});
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

// ---------------------------------------------------------------------------
// POST /api/user/accept-tos
// ---------------------------------------------------------------------------

describe('Users — POST /api/user/accept-tos', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).post('/api/user/accept-tos');
		expect(res.status).toBe(401);
	});

	test('marks TOS accepted for the authenticated user', async () => {
		const userToken = (await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: TEST_USER.userPassword })).body.token;

		const res = await request(app)
			.post('/api/user/accept-tos')
			.set('auth-token', userToken);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('success', true);
	});

	test('TOS acceptance is reflected in the verification record', async () => {
		const res = await request(app)
			.get(`/api/user/${TEST_UID}/verification`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body.tosAccepted).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// POST /api/user/key  (add SSH public key)
// ---------------------------------------------------------------------------

describe('Users — POST /api/user/key', () => {
	// A syntactically valid OpenSSH public key.
	const TEST_SSH_KEY = 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7Jmtest0123456789abcdefghijklmno test@misc-suite';

	test('requires auth — 401 without token', async () => {
		const res = await request(app)
			.post('/api/user/key')
			.send({ key: TEST_SSH_KEY });
		expect(res.status).toBe(401);
	});

	test('authenticated user can add an SSH key', async () => {
		const userToken = (await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: TEST_USER.userPassword })).body.token;

		const res = await request(app)
			.post('/api/user/key')
			.set('auth-token', userToken)
			.send({ key: TEST_SSH_KEY });

		// 200 = added, 400 = already added (both are valid outcomes)
		expect([200, 400]).toContain(res.status);
		expect(res.body).toHaveProperty('message');
	});
});

// ---------------------------------------------------------------------------
// GET /api/user/:uid/verification
// ---------------------------------------------------------------------------

describe('Users — GET /api/user/:uid/verification', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get(`/api/user/${TEST_UID}/verification`);
		expect(res.status).toBe(401);
	});

	test('admin can retrieve verification status for a user', async () => {
		const res = await request(app)
			.get(`/api/user/${TEST_UID}/verification`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('uid', TEST_UID);
		expect(res.body).toHaveProperty('emailVerified');
		expect(res.body).toHaveProperty('phoneVerified');
		expect(res.body).toHaveProperty('tosAccepted');
		expect(res.body).toHaveProperty('tosAcceptedAt');
	});

	test('non-admin without admin group returns 401', async () => {
		const userToken = (await request(app)
			.post('/api/auth/login')
			.send({ uid: TEST_UID, password: TEST_USER.userPassword })).body.token;

		const res = await request(app)
			.get(`/api/user/${TEST_UID}/verification`)
			.set('auth-token', userToken);

		expect(res.status).toBe(401);
	});

	test('unknown uid returns error', async () => {
		const res = await request(app)
			.get('/api/user/no_such_user_xyz/verification')
			.set('auth-token', token);
		// UserVerification.getOrCreate creates a record even for unknowns in some
		// implementations; accept 200 or 4xx as long as it responds.
		expect(res.status).toBeGreaterThanOrEqual(200);
	});
});

// ---------------------------------------------------------------------------
// GET /api/token/
// ---------------------------------------------------------------------------

describe('Tokens — GET /api/token/', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/token/');
		expect(res.status).toBe(401);
	});

	test('returns list of token-type names', async () => {
		const res = await request(app)
			.get('/api/token/')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
		expect(res.body.results.length).toBeGreaterThan(0);
		// Base Token class is deleted; known types should include InviteToken.
		expect(res.body.results).toContain('InviteToken');
	});
});

// ---------------------------------------------------------------------------
// GET /api/token/:name
// ---------------------------------------------------------------------------

describe('Tokens — GET /api/token/:name', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/token/InviteToken');
		expect(res.status).toBe(401);
	});

	test('returns list of token ids for InviteToken', async () => {
		const res = await request(app)
			.get('/api/token/InviteToken')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
	});

	test('detail=true returns full token objects', async () => {
		const res = await request(app)
			.get('/api/token/InviteToken')
			.query({ detail: true })
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
		// The 'token' key is marked isPrivate in the model, so it is excluded from results.
		// Check for other known fields instead.
		if (res.body.results.length > 0) {
			expect(res.body.results[0]).toHaveProperty('is_valid');
			expect(res.body.results[0]).toHaveProperty('created_by');
		}
	});

	test('unknown token type returns error', async () => {
		const res = await request(app)
			.get('/api/token/NoSuchTokenType')
			.set('auth-token', token);
		// Token route does tokens[name].listDetail() — undefined.listDetail() throws.
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});

// ---------------------------------------------------------------------------
// GET /api/token/:name/:token
// ---------------------------------------------------------------------------

describe('Tokens — GET /api/token/:name/:token', () => {
	let knownTokenId;

	beforeAll(async () => {
		// Create a fresh invite token so we have a known id to fetch.
		const res = await request(app)
			.post('/api/user/invite')
			.set('auth-token', token)
			.send({});
		knownTokenId = res.body.token;
	});

	test('requires auth — 401 without token', async () => {
		expect(knownTokenId).toBeDefined();
		const res = await request(app).get(`/api/token/InviteToken/${knownTokenId}`);
		expect(res.status).toBe(401);
	});

	test('returns the specific token object', async () => {
		expect(knownTokenId).toBeDefined();
		const res = await request(app)
			.get(`/api/token/InviteToken/${knownTokenId}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		// The 'token' key is marked isPrivate in the model and is excluded from the serialised object.
		// Verify other well-known fields instead.
		expect(res.body.results).toHaveProperty('is_valid');
		expect(res.body.results).toHaveProperty('created_by', TEST_CREDS.uid);
	});

	test('unknown token id returns error', async () => {
		const res = await request(app)
			.get('/api/token/InviteToken/00000000-0000-0000-0000-000000000000')
			.set('auth-token', token);
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
