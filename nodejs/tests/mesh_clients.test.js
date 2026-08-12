'use strict';

// Device enrolment: address allocation, key custody, and who may use which
// exit. The models are mocked because these rules are the interesting part --
// the ORM is exercised by the integration suite.

const mockRows = { clients: [], grants: [] };

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

// withLock is a real distributed lock over Redis; here it just has to run the
// body. The serialization it provides IS tested, in tests/mutex.test.js.
jest.mock('../utils/mutex', () => ({ withLock: async (name, fn) => fn() }));

const clients = require('../utils/mesh_clients');

beforeEach(() => { mockRows.clients = []; mockRows.grants = []; });

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

	// `exitOpen` on a site means it is WILLING to carry traffic. Permission is
	// a separate, explicit decision, so an admin can always override.
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
