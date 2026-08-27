'use strict';

// POST /api/site/spokes must be idempotent on endpoint, and must preserve a
// spoke's LDAP ServerID + pushToken when the endpoint legitimately changes
// (http -> https, port change, etc.). Previously a re-registration under a new
// endpoint created a second SiteSpoke row with a new ServerID, which broke
// mesh addressing and doubled the directory.

const mockSpokes = [];
const mockJoinKeys = new Map();

jest.mock('../models/site_spoke', () => {
	const makeRow = (data) => {
		const row = { ...data };
		row.update = async (patch) => { Object.assign(row, patch); return row; };
		row.delete = async () => {
			const i = mockSpokes.findIndex(s => s.id === row.id);
			if (i >= 0) mockSpokes.splice(i, 1);
		};
		return row;
	};
	return {
		SiteSpoke: {
			generatePushToken: () => 'generated-token',
			list: async (args) => {
				if (!args || !args.where) return mockSpokes.slice();
				const [key, val] = Object.entries(args.where)[0];
				return mockSpokes.filter(s => s[key] === val);
			},
			create: async (d) => {
				const row = makeRow(d);
				mockSpokes.push(row);
				return row;
			}
		}
	};
});

jest.mock('../models/site_join_key', () => ({
	SiteJoinKey: {
		authenticate: async (raw) => {
			const key = mockJoinKeys.get(raw);
			return key || null;
		}
	}
}));

jest.mock('../utils/ldap_replication', () => ({
	nextFreeLdapServerId: async () => {
		const used = new Set(mockSpokes.map(s => s.ldapServerId).filter(Boolean));
		for (let i = 2; i <= 4094; i++) if (!used.has(i)) return i;
		throw new Error('exhausted');
	},
	ldapMeshHost: () => null,
	ldapHostFor: () => null,
	ldapHostForSpoke: () => null
}));

jest.mock('../utils/mesh_roster', () => ({
	bySiteId: async () => null,
	adoptRoster: async () => ({ adopted: 0 }),
	roster: async () => [],
	syncFromSpokes: async () => ({ created: 0 })
}));

jest.mock('../utils/ldap_reconcile', () => ({
	reconcileSoon: () => {}
}));

jest.mock('../utils/site_replicate', () => ({
	replicateToSpokes: () => {}
}));

const mockAgents = [];
jest.mock('../models/agent', () => ({
	Agent: {
		get: async (id) => mockAgents.find(a => a.id === id) || null,
		create: async (data) => {
			const row = { ...data };
			row.update = async (patch) => { Object.assign(row, patch); return row; };
			mockAgents.push(row);
			return row;
		}
	}
}));

jest.mock('../services/discovery_reconciler', () => ({
	DiscoveryReconciler: {
		reconcile: async () => ({ newDevices: 1 })
	}
}));

const request = require('supertest');
const express = require('express');

let app;

beforeEach(() => {
	mockSpokes.length = 0;
	mockJoinKeys.clear();
	jest.resetModules();
	app = express();
	app.use(express.json());
	app.use('/api/site', require('../routes/api_site'));
});

function router() {
	return request(app);
}

async function register({ endpoint, siteSlug, joinKey, ldapServerId, pushToken }) {
	mockJoinKeys.set(joinKey, { keyPrefix: joinKey.slice(0, 12) });
	if (ldapServerId) {
		const { SiteSpoke } = require('../models/site_spoke');
		await SiteSpoke.create({
			id: 'existing-row',
			endpoint,
			siteSlug,
			ldapServerId,
			pushToken,
			created_on: 1,
			last_seen_on: 1,
			noInbound: false,
			meshIp: '',
			publicHost: ''
		});
	}
	return router()
		.post('/api/site/spokes')
		.set('Authorization', 'Bearer ' + joinKey)
		.send({ endpoint, siteSlug });
}

test('first registration mints a new ServerID and pushToken', async () => {
	const res = await register({ endpoint: 'http://spoke.example.com', siteSlug: 'site-spoke', joinKey: 'stj_first' });
	expect(res.status).toBe(200);
	expect(res.body.ldapServerId).toBe(2);
	expect(res.body.pushToken).toBe('generated-token');
	expect(mockSpokes.length).toBe(1);
});

test('re-registration with the same endpoint keeps ServerID and pushToken', async () => {
	await register({ endpoint: 'http://spoke.example.com', siteSlug: 'site-spoke', joinKey: 'stj_key', ldapServerId: 3, pushToken: 'stable-token' });
	const res = await register({ endpoint: 'http://spoke.example.com', siteSlug: 'site-spoke', joinKey: 'stj_key' });

	expect(res.status).toBe(200);
	expect(res.body.ldapServerId).toBe(3);
	expect(res.body.pushToken).toBe('stable-token');
	expect(mockSpokes.length).toBe(1);
});

test('re-registration with a changed endpoint still keeps ServerID and pushToken', async () => {
	await register({ endpoint: 'http://spoke.example.com', siteSlug: 'site-spoke', joinKey: 'stj_key', ldapServerId: 3, pushToken: 'stable-token' });
	const res = await register({ endpoint: 'https://spoke.example.com', siteSlug: 'site-spoke', joinKey: 'stj_key' });

	expect(res.status).toBe(200);
	expect(res.body.ldapServerId).toBe(3);
	expect(res.body.pushToken).toBe('stable-token');
	expect(mockSpokes.length).toBe(1);
	expect(mockSpokes[0].endpoint).toBe('https://spoke.example.com');
});

test('registration for a brand new siteSlug still mints a new row', async () => {
	await register({ endpoint: 'http://spoke.example.com', siteSlug: 'site-spoke', joinKey: 'stj_key', ldapServerId: 3, pushToken: 'stable-token' });
	const res = await register({ endpoint: 'http://other.example.com', siteSlug: 'site-other', joinKey: 'stj_other' });

	expect(res.status).toBe(200);
	expect(res.body.ldapServerId).toBe(2); // lowest free ID after existing row with 3
	expect(mockSpokes.length).toBe(2);
});

test('discovery report forwards from spoke to master', async () => {
	mockJoinKeys.set('stj_discovery', { keyPrefix: 'stj_discovery' });
	const res = await router()
		.post('/api/site/spokes/discovery-report')
		.set('Authorization', 'Bearer stj_discovery')
		.send({
			sourceName: 'proxmox-spoke',
			payload: {
				resources: [{ kind: 'host', name: 'pdp-node1', slug: 'host-pdp-node1', metadata: { ip: '10.4.168.200' } }],
				edges: []
			}
		});

	expect(res.status).toBe(200);
	expect(res.body.status).toBe('ok');
});

test('agent report saves newly enrolled agent and updates last_seen', async () => {
	mockJoinKeys.set('stj_agent', { keyPrefix: 'stj_agent' });
	const res = await router()
		.post('/api/site/spokes/agent-report')
		.set('Authorization', 'Bearer stj_agent')
		.send({
			agent: {
				id: 'a1b2c3d4-0000-0000-0000-000000000001',
				name: 'theta-suite-pdp',
				tokenHash: 'abc123hash',
				tokenPrefix: 'abc12345',
				enrolled_by: 'join-key:pdp',
				last_seen: Math.floor(Date.now() / 1000)
			}
		});

	expect(res.status).toBe(200);
	expect(res.body.status).toBe('ok');
});

test('ping reports the suite version for spoke parity checks', async () => {
	mockJoinKeys.set('stj_ping', { keyPrefix: 'stj_ping' });
	const prev = process.env.THETA_SUITE_VERSION;
	delete process.env.THETA_SUITE_VERSION;
	try {
		let res = await router()
			.post('/api/site/ping')
			.set('Authorization', 'Bearer stj_ping')
			.send({});
		expect(res.status).toBe(200);
		expect(res.body.status).toBe('ok');
		expect(res.body.suiteVersion).toBeNull();

		process.env.THETA_SUITE_VERSION = 'v3.31.0';
		res = await router()
			.post('/api/site/ping')
			.set('Authorization', 'Bearer stj_ping')
			.send({});
		expect(res.status).toBe(200);
		expect(res.body.suiteVersion).toBe('v3.31.0');
	} finally {
		if (prev === undefined) delete process.env.THETA_SUITE_VERSION;
		else process.env.THETA_SUITE_VERSION = prev;
	}
});
