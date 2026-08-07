'use strict';

// Agent-facing ops (DESIGN.md §5): node-scoped secrets. OpenBao is not present
// in the test env, so @simpleworkjs/bao-conf is mocked.

jest.mock('@simpleworkjs/bao-conf', () => ({
	request: jest.fn(async (method, path) => {
		if (path.startsWith('secret/data/nodes/')) {
			return {
				ok: true,
				status: 200,
				json: async () => ({ data: { data: { username: 'alice', password: 's3cret' } } }),
			};
		}
		return { ok: false, status: 404, json: async () => ({}) };
	}),
}));

const { request, app } = require('./setup');
const { Agent } = require('../models/agent');

async function enrollAgent() {
	const { agent, token } = await Agent.enroll({
		name: `ops-test-${Date.now().toString(36)}`,
		description: 'api_agent_ops test',
		enrolledBy: 'test'
	});
	return { agent, token };
}

describe('Agent ops — POST /api/v1/agent/secrets', () => {
	test('an agent can fetch its own node-scoped secrets', async () => {
		const { agent, token } = await enrollAgent();
		const path = `secret/data/nodes/${agent.id}/db`;
		const res = await request(app)
			.post('/api/v1/agent/secrets')
			.set('Authorization', `Bearer ${token}`)
			.send({ paths: [path] });

		expect(res.status).toBe(200);
		expect(res.body.status).toBe('ok');
		expect(res.body.secrets[path]).toEqual({ username: 'alice', password: 's3cret' });
	});

	test('a path outside the node scope is rejected', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/agent/secrets')
			.set('Authorization', `Bearer ${token}`)
			.send({ paths: ['secret/data/nodes/other-node/db'] });

		expect(res.status).toBe(403);
	});

	test('no bearer token returns 401', async () => {
		const res = await request(app)
			.post('/api/v1/agent/secrets')
			.send({ paths: ['secret/data/nodes/x/db'] });

		expect(res.status).toBe(401);
	});

	test('missing paths returns 400', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/agent/secrets')
			.set('Authorization', `Bearer ${token}`)
			.send({});

		expect(res.status).toBe(400);
	});
});
