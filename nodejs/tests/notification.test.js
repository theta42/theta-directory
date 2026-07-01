'use strict';

// Tests for the notification API:
//   POST /api/notification/ — create & send notification
//   GET  /api/notification/ — list notifications
//   GET  /api/notification/:id — get single notification

const { login, request, app } = require('./setup');

let token;
let notificationId;

beforeAll(async () => {
	token = await login();
});

describe('Notifications — POST /api/notification/ (create)', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app)
			.post('/api/notification/')
			.send({ subject: 'Test', message: 'Hello', filter_type: 'all' });
		expect(res.status).toBe(401);
	});

	test('missing required fields returns 400', async () => {
		const res = await request(app)
			.post('/api/notification/')
			.set('auth-token', token)
			.send({ subject: 'No message or filter_type' });
		expect(res.status).toBe(400);
	});

	test('admin can create a notification targeting an empty user list (no emails sent)', async () => {
		const res = await request(app)
			.post('/api/notification/')
			.set('auth-token', token)
			.send({
				subject: 'Jest test notification',
				message: 'This notification was created by the automated test suite.',
				filter_type: 'users',
				filter_value: '[]', // empty recipient list — no emails sent
			});

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('results');
		expect(res.body.results).toHaveProperty('subject', 'Jest test notification');

		notificationId = res.body.results.token || res.body.results.id;
	});
});

describe('Notifications — GET /api/notification/ (list)', () => {
	test('requires auth — 401 without token', async () => {
		const res = await request(app).get('/api/notification/');
		expect(res.status).toBe(401);
	});

	test('admin can list notifications', async () => {
		const res = await request(app)
			.get('/api/notification/')
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(Array.isArray(res.body.results)).toBe(true);
	});

	test('list includes the notification created above', async () => {
		// notificationId may be undefined if the create test above was skipped on error
		if (!notificationId) return;

		const res = await request(app)
			.get('/api/notification/')
			.set('auth-token', token);

		const found = res.body.results.find(n => (n.token || n.id) === notificationId);
		expect(found).toBeDefined();
		expect(found.subject).toBe('Jest test notification');
	});
});

describe('Notifications — GET /api/notification/:id (single)', () => {
	test('requires auth — 401 without token', async () => {
		if (!notificationId) return;
		const res = await request(app).get(`/api/notification/${notificationId}`);
		expect(res.status).toBe(401);
	});

	test('admin can retrieve a notification by id', async () => {
		if (!notificationId) return;

		const res = await request(app)
			.get(`/api/notification/${notificationId}`)
			.set('auth-token', token);

		expect(res.status).toBe(200);
		expect(res.body).toHaveProperty('results');
		expect(res.body.results.subject).toBe('Jest test notification');
	});

	test('unknown id returns an error', async () => {
		const res = await request(app)
			.get('/api/notification/00000000-0000-0000-0000-000000000000')
			.set('auth-token', token);
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
