'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const path = require('path');
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

	test('agent toPublic reports isOnline true when recently active on another node', async () => {
		const { agent } = await Agent.enroll({
			name: 'peer-node-agent',
			description: 'Connected on spoke'
		});

		// Seen 30 seconds ago on a spoke
		await agent.update({ last_seen: Math.floor(Date.now() / 1000) - 30 });

		// On this node, liveState is { connected: false }
		const pub = agent.toPublic({ connected: false });
		expect(pub.connected).toBe(false);
		expect(pub.isOnline).toBe(true);

		// Seen 10 minutes ago
		await agent.update({ last_seen: Math.floor(Date.now() / 1000) - 600 });
		const pubOld = agent.toPublic({ connected: false });
		expect(pubOld.connected).toBe(false);
		expect(pubOld.isOnline).toBe(false);
	});

	test('agent artifacts endpoint lists the staged release catalog', async () => {
		const dir = path.join(__dirname, '..', 'public', 'resources', 'theta-agent');
		const created = [];
		const cleanup = () => {
			for (const f of created) {
				try { fs.unlinkSync(f); } catch (err) { /* already gone */ }
			}
		};
		try {
			// Baseline: the repo ships install.sh committed, so exactly that
			// entry is staged; everything else is not, and no version is
			// derivable without the versioned installer present.
			const emptyRes = await request(app).get('/api/agent/artifacts');
			expect(emptyRes.status).toBe(200);
			expect(emptyRes.body.status).toBe('ok');
			expect(Array.isArray(emptyRes.body.artifacts)).toBe(true);
			expect(emptyRes.body.artifacts.length).toBeGreaterThanOrEqual(14);
			expect(emptyRes.body.version).toBeNull();
			const install = emptyRes.body.artifacts.find(a => a.file === 'install.sh');
			expect(install).toBeDefined();
			expect(install.staged).toBe(true);
			expect(emptyRes.body.artifacts.filter(a => a.file !== 'install.sh').every(a => !a.staged)).toBe(true);

			// Stage three files: the versioned installer (which carries the
			// release version), the stable alias setup.sh copies it to, and a
			// stable-name binary the agent's self-update fetches.
			const stagedFiles = [
				'theta-agent-0.9.8-windows-amd64-setup.exe',
				'theta-agent-windows-amd64-setup.exe',
				'theta-agent-linux-amd64'
			];
			for (const f of stagedFiles) {
				const p = path.join(dir, f);
				fs.writeFileSync(p, 'x');
				created.push(p);
			}

			const res = await request(app).get('/api/agent/artifacts');
			expect(res.status).toBe(200);
			expect(res.body.version).toBe('0.9.8');
			const byId = Object.fromEntries(res.body.artifacts.map(a => [a.id, a]));
			expect(byId['linux-amd64'].staged).toBe(true);
			expect(byId['linux-amd64'].size).toBe(1);
			expect(byId['winsetup'].staged).toBe(true);
			expect(byId['install'].staged).toBe(true);
			for (const a of res.body.artifacts) {
				expect(a.file).toBeTruthy();
				expect(a.purpose).toBeTruthy();
			}
		} finally {
			cleanup();
		}
	});
});
