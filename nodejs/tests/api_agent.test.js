'use strict';

const express = require('express');
const request = require('supertest');
const { initORM } = require('../models');
const { Agent } = require('../models/agent');
const siteReplicate = require('../utils/site_replicate');
const permission = require('../utils/permission');
const middleware = require('../middleware/auth');

describe('Agent REST API & Live Resync Triggers', () => {
	let app;
	let replicateSpy;
	let authSpy;
	let permSpy;

	beforeAll(async () => {
		await initORM();
		authSpy = jest.spyOn(middleware, 'auth').mockImplementation((req, res, next) => {
			req.user = { uid: 'admin' };
			next();
		});
		permSpy = jest.spyOn(permission, 'byGroup').mockImplementation(() => Promise.resolve(true));

		app = express();
		app.use(express.json());
		app.use('/api/agent', require('../routes/api_agent'));
	});

	afterAll(() => {
		authSpy.mockRestore();
		permSpy.mockRestore();
	});

	beforeEach(() => {
		replicateSpy = jest.spyOn(siteReplicate, 'replicateToSpokes').mockImplementation(() => Promise.resolve());
	});

	afterEach(() => {
		if (replicateSpy) replicateSpy.mockRestore();
	});

	test('agent lifecycle triggers resync pushes on master', async () => {
		// 1. Enroll agent -> triggers 'agent-enrolled'
		const enrollRes = await request(app)
			.post('/api/agent/enroll')
			.send({ name: 'test-agent-host', description: 'Testing resync triggers' });

		expect(enrollRes.status).toBe(200);
		expect(enrollRes.body.status).toBe('ok');
		expect(enrollRes.body.agent).toBeDefined();
		expect(enrollRes.body.token).toBeDefined();

		const agentId = enrollRes.body.agent.id;
		expect(replicateSpy).toHaveBeenCalledWith('agent-enrolled');

		// 2. Update agent -> triggers 'agent-updated'
		replicateSpy.mockClear();
		const updateRes = await request(app)
			.put(`/api/agent/nodes/${agentId}`)
			.send({ description: 'Updated agent description' });

		expect(updateRes.status).toBe(200);
		expect(updateRes.body.agent.description).toBe('Updated agent description');
		expect(replicateSpy).toHaveBeenCalledWith('agent-updated');

		// 3. Rotate agent token -> triggers 'agent-token-rotated'
		replicateSpy.mockClear();
		const rotateRes = await request(app)
			.post(`/api/agent/nodes/${agentId}/rotate`);

		expect(rotateRes.status).toBe(200);
		expect(rotateRes.body.token).toBeDefined();
		expect(replicateSpy).toHaveBeenCalledWith('agent-token-rotated');

		// 4. Revoke agent -> triggers 'agent-revoked'
		replicateSpy.mockClear();
		const revokeRes = await request(app)
			.post(`/api/agent/nodes/${agentId}/revoke`);

		expect(revokeRes.status).toBe(200);
		expect(revokeRes.body.status).toBe('ok');
		expect(replicateSpy).toHaveBeenCalledWith('agent-revoked');

		// 5. Delete agent -> triggers 'agent-deleted'
		replicateSpy.mockClear();
		const deleteRes = await request(app)
			.delete(`/api/agent/nodes/${agentId}`);

		expect(deleteRes.status).toBe(200);
		expect(deleteRes.body.status).toBe('ok');
		expect(replicateSpy).toHaveBeenCalledWith('agent-deleted');
	});
});
