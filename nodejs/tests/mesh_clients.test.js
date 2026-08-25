'use strict';

// Device enrolment: address allocation, key custody, and who may use which
// exit. The models are mocked because these rules are the interesting part --
// the ORM is exercised by the integration suite.

const mockRows = { clients: [], grants: [], sites: [] };

// Named with a `mock` prefix because jest.mock() factories are hoisted above
// the file and may only close over variables it can prove are mock scaffolding.
class mockFakeRow {
	constructor(data, bucket) { Object.assign(this, data); this._bucket = bucket; }
	async update(patch) { Object.assign(this, patch); return this; }
	async delete() {
		const i = mockRows[this._bucket].indexOf(this);
		if (i >= 0) mockRows[this._bucket].splice(i, 1);
	}
}

const mockMatches = (row, where) => Object.entries(where || {}).every(([k, v]) => {
	if (v === null) return row[k] === null || row[k] === undefined;
	return String(row[k]) === String(v);
});

jest.mock('../models/mesh_client', () => ({
	MeshClient: {
		list: async (opts) => mockRows.clients.filter((r) => mockMatches(r, opts && opts.where)),
		create: async (data) => { const r = new mockFakeRow(data, 'clients'); mockRows.clients.push(r); return r; }
	},
	MeshExitGrant: {
		list: async (opts) => mockRows.grants.filter((r) => mockMatches(r, opts && opts.where)),
		create: async (data) => { const r = new mockFakeRow(data, 'grants'); mockRows.grants.push(r); return r; }
	}
}));

// allowedExits() reads the site roster too, now that every site offering an
// exit is usable by every user rather than only those an admin granted.
jest.mock('../models/mesh_site', () => ({
	MeshSite: {
		list: async (opts) => mockRows.sites.filter((r) => mockMatches(r, opts && opts.where))
	}
}));

// withLock is a real distributed lock over Redis; here it just has to run the
// body. The serialization it provides IS tested, in tests/mutex.test.js.
jest.mock('../utils/mutex', () => ({ withLock: async (name, fn) => fn() }));

const clients = require('../utils/mesh_clients');

beforeEach(() => { mockRows.clients = []; mockRows.grants = []; mockRows.sites = []; });

const PUBKEY_A = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE=';

describe('addressing', () => {
	test('the first device at a site takes the bottom of the pool', async () => {
		expect(await clients.nextFreeIp(2)).toBe('10.2.128.1');
	});

	test('addresses are handed out in order and never reused while live', async () => {
		await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.enroll({ uid: 'alice', name: 'phone', siteId: 2 });
		expect(mockRows.clients.map((c) => c.assignedIp)).toEqual(['10.2.128.1', '10.2.128.2']);
	});

	// Lowest-free rather than a counter: a counter marches upward forever and
	// eventually exhausts a pool that is mostly empty.
	test('removing a device returns its address to the pool', async () => {
		const { client: first } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.enroll({ uid: 'alice', name: 'phone', siteId: 2 });
		await first.delete();
		expect(await clients.nextFreeIp(2)).toBe('10.2.128.1');
	});

	test('each site allocates from its own pool independently', async () => {
		await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		const { client } = await clients.enroll({ uid: 'bob', name: 'laptop', siteId: 5 });
		expect(client.assignedIp).toBe('10.5.128.1');
	});
});

describe('key custody', () => {
	// The private key is the one thing that must never be persisted. It exists
	// on the response and nowhere else.
	test('a server-generated key is returned once and never stored', async () => {
		const { client, privateKey } = await clients.enroll({ uid: 'alice', name: 'phone', siteId: 2 });
		expect(privateKey).toBeTruthy();
		expect(privateKey.length).toBe(44);
		expect(client.publicKey).toBeTruthy();
		expect(client.privateKey).toBeUndefined();
		expect(JSON.stringify(client).includes(privateKey)).toBe(false);
	});

	test('a device that supplies its own public key gets no private key back', async () => {
		const { client, privateKey } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2, publicKey: PUBKEY_A });
		expect(privateKey).toBe(null);
		expect(client.publicKey).toBe(PUBKEY_A);
		expect(client.source).toBe('agent');
	});

	test('a malformed public key is rejected before it reaches a gateway', async () => {
		// `wg` would reject this too, but on a gateway, where nobody is looking.
		await expect(clients.enroll({ uid: 'a', name: 'x', siteId: 2, publicKey: 'not-a-key' }))
			.rejects.toThrow(/not a valid WireGuard public key/);
	});

	test('the same key cannot be enrolled twice', async () => {
		await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2, publicKey: PUBKEY_A });
		await expect(clients.enroll({ uid: 'bob', name: 'other', siteId: 2, publicKey: PUBKEY_A }))
			.rejects.toThrow(/already enrolled/);
	});
});

describe('config push on exit change', () => {
	// Switching between two exits leaves AllowedIPs at 0.0.0.0/0 and the
	// gateway reroutes, but crossing the local-breakout boundary flips it
	// between 0.0.0.0/0 and the split-tunnel pair -- so the device needs the
	// new config. Both the web UI and the tray go through this helper.
	test('a device with no agent is never pushed to', async () => {
		const { client } = await clients.enroll({ uid: 'alice', name: 'phone', siteId: 2 });
		expect(await clients.pushConfigToAgent(client)).toBe(false);
	});

	test('a missing device is handled rather than thrown', async () => {
		expect(await clients.pushConfigToAgent(null)).toBe(false);
	});

	// Best-effort: the selection is already persisted and the gateway
	// reconciles on its own, so an unreachable agent must not fail the change.
	test('a push failure is swallowed, not thrown', async () => {
		const { client } = await clients.enroll({
			uid: 'alice', name: 'laptop', siteId: 2, agentId: 'agent-1'
		});
		await expect(clients.pushConfigToAgent(client)).resolves.toBe(false);
	});

	// The agent decides whether the tunnel should be UP from its own site id
	// and the exit it is on (theta-agent home_detect.go). Sending both with
	// the config is what lets a config be delivered ahead of the moment it is
	// needed instead of forcing the tunnel up on arrival.
	test('the push carries the site and exit the decision depends on', async () => {
		const sent = [];
		jest.resetModules();
		jest.doMock('../utils/agent_manager', () => ({
			sendCommand: async (agent, type, payload) => { sent.push({ type, payload }); }
		}), { virtual: false });
		jest.doMock('../utils/mesh_roster', () => ({
			bySiteId: async () => ({
				siteId: 2, slug: 'site-home', gatewayPublicKey: 'k', gatewayEndpoint: 'gw:51820',
				lan168: '192.168.1.0/24', lan172: '172.16.0.0/24', dnsHost: '192.168.1.1'
			})
		}));
		jest.doMock('../models/agent', () => ({ Agent: { list: async () => [{ id: 'agent-1' }] } }));

		const fresh = require('../utils/mesh_clients');
		const pushed = await fresh.pushConfigToAgent({
			id: 'c1', name: 'laptop', siteId: 2, assignedIp: '10.2.128.5',
			exitSiteId: 7, agentId: 'agent-1'
		});

		expect(pushed).toBe(true);
		expect(sent).toHaveLength(1);
		expect(sent[0].type).toBe('wireguard_apply');
		expect(sent[0].payload.siteId).toBe(2);
		expect(sent[0].payload.exitSiteId).toBe(7);
		expect(sent[0].payload.config).toContain('10.2.128.5/32');
		jest.dontMock('../utils/agent_manager');
		jest.dontMock('../utils/mesh_roster');
		jest.dontMock('../models/agent');
		jest.resetModules();
	});

	test('no exit is sent as null, not omitted', async () => {
		const sent = [];
		jest.resetModules();
		jest.doMock('../utils/agent_manager', () => ({
			sendCommand: async (agent, type, payload) => { sent.push(payload); }
		}));
		jest.doMock('../utils/mesh_roster', () => ({
			bySiteId: async () => ({
				siteId: 2, slug: 'site-home', gatewayPublicKey: 'k', gatewayEndpoint: 'gw:51820',
				lan168: '192.168.1.0/24', lan172: '172.16.0.0/24'
			})
		}));
		jest.doMock('../models/agent', () => ({ Agent: { list: async () => [{ id: 'agent-1' }] } }));

		const fresh = require('../utils/mesh_clients');
		await fresh.pushConfigToAgent({
			id: 'c1', name: 'laptop', siteId: 2, assignedIp: '10.2.128.5',
			exitSiteId: null, agentId: 'agent-1'
		});
		expect(sent[0]).toHaveProperty('exitSiteId', null);
		jest.dontMock('../utils/agent_manager');
		jest.dontMock('../utils/mesh_roster');
		jest.dontMock('../models/agent');
		jest.resetModules();
	});
});

describe('exit selection', () => {
	test('a user may not pick an exit they were not granted', async () => {
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await expect(clients.setExit(client, 5)).rejects.toThrow(/not permitted/);
		expect(client.exitSiteId).toBe(null);
	});

	test('a granted exit can be selected', async () => {
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.grantExit('alice', 5, 'admin');
		await clients.setExit(client, 5);
		expect(client.exitSiteId).toBe(5);
	});

	// Every site that offers an exit is usable by every user. This used to
	// require BOTH exitOpen on the site AND a per-user grant -- two gates, both
	// closed by default, so a stock deployment had no usable exit anywhere.
	test('any user can select a site that offers an exit, with no grant', async () => {
		mockRows.sites.push({ siteId: 5, exitOpen: true });
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.setExit(client, 5);
		expect(client.exitSiteId).toBe(5);
	});

	test('allowedExits lists every exit-open site plus explicit grants', async () => {
		mockRows.sites.push({ siteId: 3, exitOpen: true }, { siteId: 5, exitOpen: true });
		await clients.grantExit('alice', 9, 'admin');
		const allowed = await clients.allowedExits('alice');
		expect([...allowed].sort((a, b) => a - b)).toEqual([3, 5, 9]);
	});

	// A site taken out of the pool deliberately (a metered link) stays out.
	test('a site with exitOpen false is still refused without a grant', async () => {
		mockRows.sites.push({ siteId: 5, exitOpen: false });
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await expect(clients.setExit(client, 5)).rejects.toThrow(/not permitted/);
		expect(client.exitSiteId).toBe(null);
	});

	// An explicit grant still works for a site that is NOT in the open pool --
	// that is the whole point of keeping grants alongside the open default.
	test('an explicit grant still opens a closed site for one user', async () => {
		mockRows.sites.push({ siteId: 5, exitOpen: false });
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.grantExit('alice', 5, 'admin');
		await clients.setExit(client, 5);
		expect(client.exitSiteId).toBe(5);
	});

	// Permission is still a decision an admin can always override.
	test('an admin can set an exit without a grant', async () => {
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.setExit(client, 5, { isAdmin: true });
		expect(client.exitSiteId).toBe(5);
	});

	test('clearing an exit falls back to local breakout', async () => {
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.grantExit('alice', 5, 'admin');
		await clients.setExit(client, 5);
		await clients.setExit(client, null);
		expect(client.exitSiteId).toBe(null);
	});

	// Revoking access must not leave a device still routed through an exit its
	// owner may no longer use.
	test('revoking a grant drops devices back to local breakout', async () => {
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await clients.grantExit('alice', 5, 'admin');
		await clients.setExit(client, 5);

		await clients.revokeExit('alice', 5);
		expect(client.exitSiteId).toBe(null);
		expect([...(await clients.allowedExits('alice'))]).toEqual([]);
	});

	test('granting twice does not create a duplicate', async () => {
		await clients.grantExit('alice', 5, 'admin');
		await clients.grantExit('alice', 5, 'admin');
		expect(mockRows.grants.length).toBe(1);
	});

	test('an exit site id outside the addressing range is refused', async () => {
		const { client } = await clients.enroll({ uid: 'alice', name: 'laptop', siteId: 2 });
		await expect(clients.setExit(client, 999, { isAdmin: true })).rejects.toThrow(/site id must be an integer/);
	});
});

describe('enrolment guards', () => {
	test('a device needs an owner and a name', async () => {
		await expect(clients.enroll({ name: 'x', siteId: 2 })).rejects.toThrow(/uid is required/);
		await expect(clients.enroll({ uid: 'a', siteId: 2 })).rejects.toThrow(/device name is required/);
	});

	test('a device cannot be enrolled at a site id that has no address space', async () => {
		await expect(clients.enroll({ uid: 'a', name: 'x', siteId: 300 })).rejects.toThrow(/site id must be an integer/);
	});
});
