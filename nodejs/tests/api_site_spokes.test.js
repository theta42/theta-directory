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
