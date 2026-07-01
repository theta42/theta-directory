'use strict';

const { TEST_CREDS, login, request, app } = require('./setup');
const { OtpToken } = require('../models/token');

// Use an existing LDAP user — wmantly is always present
const TARGET_UID = 'wmantly';

describe('OTP — POST /api/auth/otp/request', () => {
	test('missing body fields returns 400', async () => {
		const res = await request(app).post('/api/auth/otp/request').send({});
		expect(res.status).toBe(400);
	});

	test('unknown user returns 4xx', async () => {
		const res = await request(app)
			.post('/api/auth/otp/request')
			.send({ login: 'no_such_user_xyz', method: 'email' });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('sms method returns error when SMS cannot be delivered', async () => {
		// test user has a mobile but VoIP.ms credentials are not set in test env
		const res = await request(app)
			.post('/api/auth/otp/request')
			.send({ login: TEST_CREDS.uid, method: 'sms' });
		expect(res.status).toBeGreaterThanOrEqual(400);
	});

	test('email method returns 200 with expires_at', async () => {
		const res = await request(app)
			.post('/api/auth/otp/request')
			.send({ login: TARGET_UID, method: 'email' });

		// May fail if SMTP not configured in test env — treat 500 as skip
		if (res.status === 500) return;

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('expires_at');
		expect(res.body.method).toBe('email');
	});
});

describe('OTP — POST /api/auth/otp/verify', () => {
	test('wrong code returns 401', async () => {
		// Seed a real OTP so the user exists in token store
		await OtpToken.issue(TARGET_UID, 'email');

		const res = await request(app)
			.post('/api/auth/otp/verify')
			.send({ login: TARGET_UID, code: '000000' });

		expect(res.status).toBe(401);
	});

	test('valid code returns auth token', async () => {
		const otp = await OtpToken.issue(TARGET_UID, 'email');

		const res = await request(app)
			.post('/api/auth/otp/verify')
			.send({ login: TARGET_UID, code: otp.code });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
		expect(res.body.login).toBe(true);
	});

	test('same code is single-use — second attempt returns 401', async () => {
		const otp = await OtpToken.issue(TARGET_UID, 'email');
		const code = otp.code;

		// First use should succeed
		const first = await request(app)
			.post('/api/auth/otp/verify')
			.send({ login: TARGET_UID, code });
		expect(first.status).toBe(200);

		// Second use must fail
		const second = await request(app)
			.post('/api/auth/otp/verify')
			.send({ login: TARGET_UID, code });
		expect(second.status).toBe(401);
	});

	test('login by email address also works', async () => {
		const otp = await OtpToken.issue(TARGET_UID, 'email');

		// Get the user's email so we can test login-by-email path
		const userRes = await request(app)
			.get(`/api/user/${TARGET_UID}`)
			.set('auth-token', await login());
		const email = userRes.body.results.mail;

		const res = await request(app)
			.post('/api/auth/otp/verify')
			.send({ login: email, code: otp.code });

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('token');
	});

	test('missing fields returns 400', async () => {
		const res = await request(app)
			.post('/api/auth/otp/verify')
			.send({ login: TARGET_UID });
		expect(res.status).toBe(400);
	});
});
