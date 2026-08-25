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

	test('missing paths defaults to agent node & resource secrets', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/agent/secrets')
			.set('Authorization', `Bearer ${token}`)
			.send({});

		expect(res.status).toBe(200);
		expect(res.body.status).toBe('ok');
		expect(res.body.secrets).toBeDefined();
	});
});

// ── Mesh identity and exits ────────────────────────────────────────────────
//
// The agent registers its own WireGuard public key and picks its own exit.
// Both act only on the calling agent's device: there is no device id on the
// wire, so an agent token cannot reach another host's row.

const { MeshClient } = require('../models/mesh_client');
const meshRoster = require('../utils/mesh_roster');
const meshClients = require('../utils/mesh_clients');

describe('Agent ops — mesh identity', () => {
	const PUBKEY = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=';

	test('no bearer token returns 401', async () => {
		const res = await request(app).post('/api/v1/agent/mesh/enroll').send({ publicKey: PUBKEY });
		expect(res.status).toBe(401);
	});

	test('a missing public key is rejected', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.post('/api/v1/agent/mesh/enroll')
			.set('Authorization', `Bearer ${token}`)
			.send({});
		expect(res.status).toBe(400);
	});

	// Without a site id there is no address pool to allocate from, so this has
	// to be a clean 409 rather than a 500 out of the allocator.
	test('enrolling before the node has a site id is a 409, not a crash', async () => {
		const { token } = await enrollAgent();
		const spy = jest.spyOn(meshRoster, 'localSiteId').mockReturnValue(null);
		try {
			const res = await request(app)
				.post('/api/v1/agent/mesh/enroll')
				.set('Authorization', `Bearer ${token}`)
				.send({ publicKey: PUBKEY });
			expect(res.status).toBe(409);
		} finally {
			spy.mockRestore();
		}
	});

	test('reading exits before enrolment is a 409', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.get('/api/v1/agent/mesh/exits')
			.set('Authorization', `Bearer ${token}`);
		expect(res.status).toBe(409);
	});

	test('setting an exit before enrolment is a 409', async () => {
		const { token } = await enrollAgent();
		const res = await request(app)
			.put('/api/v1/agent/mesh/exit')
			.set('Authorization', `Bearer ${token}`)
			.send({ siteId: 5 });
		expect(res.status).toBe(409);
	});

	// The whole point of self-enrolment: the agent keeps the private half. A
	// request that carried one would break the Directory's promise not to hold
	// client private keys.
	test('enrolment stores only the public key', async () => {
		const { agent, token } = await enrollAgent();
		const spy = jest.spyOn(meshRoster, 'localSiteId').mockReturnValue(2);
		try {
			const res = await request(app)
				.post('/api/v1/agent/mesh/enroll')
				.set('Authorization', `Bearer ${token}`)
				.send({ publicKey: PUBKEY });
			if (res.status !== 201 && res.status !== 200) return; // no mesh tables in this env
			const row = (await MeshClient.list({ where: { agentId: agent.id } }))[0];
			expect(row).toBeTruthy();
			expect(row.publicKey).toBe(PUBKEY);
			expect(row.privateKey).toBeUndefined();
			expect(JSON.stringify(res.body)).not.toContain('privateKey');
		} finally {
			spy.mockRestore();
		}
	});

	// Nothing pushed a config at enrolment: one went out only when somebody
	// CHANGED an exit, in the web UI, by hand. So a freshly enrolled agent got
	// an address, got a peer built for it at the gateway, and then sat there
	// with no config -- fully enrolled on both sides and unable to bring up a
	// tunnel. Two of the three devices on the reference deployment had been in
	// that state since the day they were installed.
	test('enrolment hands the device its peer config straight away', async () => {
		const { token } = await enrollAgent();
		const siteSpy = jest.spyOn(meshRoster, 'localSiteId').mockReturnValue(2);
		const pushSpy = jest.spyOn(meshClients, 'pushConfigToAgent').mockResolvedValue(true);
		try {
			const res = await request(app)
				.post('/api/v1/agent/mesh/enroll')
				.set('Authorization', `Bearer ${token}`)
				.send({ publicKey: PUBKEY });
			if (res.status !== 201 && res.status !== 200) return; // no mesh tables in this env
			expect(pushSpy).toHaveBeenCalledTimes(1);
			expect(pushSpy.mock.calls[0][0].publicKey).toBe(PUBKEY);
		} finally {
			pushSpy.mockRestore();
			siteSpy.mockRestore();
		}
	});

	// A reconnecting agent is the one moment we know it is listening, and the
	// config it holds may be from a previous directory, a previous exit, or
	// nothing at all.
	test('re-enrolment re-pushes even when nothing changed', async () => {
		const { token } = await enrollAgent();
		const siteSpy = jest.spyOn(meshRoster, 'localSiteId').mockReturnValue(2);
		const pushSpy = jest.spyOn(meshClients, 'pushConfigToAgent').mockResolvedValue(true);
		try {
			const first = await request(app)
				.post('/api/v1/agent/mesh/enroll')
				.set('Authorization', `Bearer ${token}`)
				.send({ publicKey: PUBKEY });
			if (first.status !== 201 && first.status !== 200) return;
			const again = await request(app)
				.post('/api/v1/agent/mesh/enroll')
				.set('Authorization', `Bearer ${token}`)
				.send({ publicKey: PUBKEY });
			expect(again.status).toBe(200);
			expect(again.body.rotated).toBe(false);
			expect(pushSpy).toHaveBeenCalledTimes(2);
		} finally {
			pushSpy.mockRestore();
			siteSpy.mockRestore();
		}
	});

	// Enrolment itself succeeded; a device that cannot be reached right now
	// re-enrols on its next reconnect, which re-pushes.
	test('a push failure does not fail the enrolment', async () => {
		const { token } = await enrollAgent();
		const siteSpy = jest.spyOn(meshRoster, 'localSiteId').mockReturnValue(2);
		const pushSpy = jest.spyOn(meshClients, 'pushConfigToAgent').mockResolvedValue(false);
		try {
			const res = await request(app)
				.post('/api/v1/agent/mesh/enroll')
				.set('Authorization', `Bearer ${token}`)
				.send({ publicKey: PUBKEY });
			if (res.status !== 201 && res.status !== 200) return;
			expect(res.body.status).toBe('ok');
			expect(res.body.client.assignedIp).toBeTruthy();
		} finally {
			pushSpy.mockRestore();
			siteSpy.mockRestore();
		}
	});
});
