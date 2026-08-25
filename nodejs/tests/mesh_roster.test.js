'use strict';

// Getting the roster to every site.
//
// This is the half the design originally missed. The roster is WRITTEN at each
// site (a gateway publishes to its own directory) but replication only flows
// master -> spoke, so without an upward path a spoke's public key never leaves
// the spoke, and without the roster in the export a spoke never learns any
// other site exists. Either gap alone means the mesh works only at whichever
// site happens to be the master.

const mockRows = { sites: [] };
let mockConfig = {};
let mockFetchCalls = [];
let mockFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });

class mockSiteRow {
	constructor(data) { Object.assign(this, data); }
	async update(patch) { Object.assign(this, patch); return this; }
}

jest.mock('../models/mesh_site', () => ({
	MeshSite: {
		list: async (opts) => {
			const where = (opts && opts.where) || {};
			return mockRows.sites.filter((r) => Object.entries(where)
				.every(([k, v]) => (typeof v === 'boolean' ? !!r[k] === v : String(r[k]) === String(v))));
		},
		create: async (data) => { const r = new mockSiteRow(data); mockRows.sites.push(r); return r; }
	}
}));
jest.mock('../models/site_spoke', () => ({ SiteSpoke: { list: async () => [] } }));
jest.mock('../utils/site_config', () => ({ get: () => mockConfig }));
// A spoke's site id comes from the ServerID its slapd is actually running with.
jest.mock('../utils/ldap_replication', () => ({ currentSlapdServerId: () => mockConfig._serverId || null }));

const roster = require('../utils/mesh_roster');

beforeEach(() => {
	mockRows.sites = [];
	mockFetchCalls = [];
	mockConfig = { isMaster: false, siteSlug: 'site-b', _serverId: 4 };
	mockFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) });
	global.fetch = async (url, opts) => { mockFetchCalls.push([url, opts]); return mockFetchImpl(url, opts); };
});

const GW_KEY = 'Z2F0ZXdheS1wdWJsaWMta2V5LTAwMDAwMDAwMDAwMDA=';

describe('publishing upward', () => {
	test('a spoke sends its gateway details to the master', async () => {
		mockConfig = { ...mockConfig, masterUrl: 'https://master.example.com/', masterJoinKey: 'jk_secret', selfUrl: 'https://b.example.com' };

		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY, gatewayEndpoint: 'b.example.com:51820' });

		expect(mockFetchCalls.length).toBe(1);
		const [url, opts] = mockFetchCalls[0];
		// Reuses the channel a spoke already has, with the credential it
		// already holds -- no second endpoint, no second secret.
		expect(url).toBe('https://master.example.com/api/site/spokes');
		expect(opts.headers.Authorization).toBe('Bearer jk_secret');
		const body = JSON.parse(opts.body);
		expect(body.gatewayPublicKey).toBe(GW_KEY);
		expect(body.gatewayEndpoint).toBe('b.example.com:51820');
		expect(body.endpoint).toBe('https://b.example.com');
	});

	test('the master does not push to itself', async () => {
		mockConfig = { isMaster: true, siteSlug: 'hq', _serverId: 1, masterUrl: '', masterJoinKey: '' };
		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY });
		expect(mockFetchCalls.length).toBe(0);
	});

	test('a spoke that never registered has nowhere to push', async () => {
		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY });
		expect(mockFetchCalls.length).toBe(0);
	});

	// A gateway must still configure itself from what it knows when the master
	// is down; a failed push cannot break local publication.
	test('an unreachable master does not fail the local publish', async () => {
		mockConfig = { ...mockConfig, masterUrl: 'https://master.example.com', masterJoinKey: 'jk', selfUrl: 'https://b.example.com' };
		mockFetchImpl = async () => { throw new Error('ECONNREFUSED'); };

		const site = await roster.publishLocalSite({ gatewayPublicKey: GW_KEY });
		expect(site.gatewayPublicKey).toBe(GW_KEY);
		expect(mockRows.sites.length).toBe(1);
	});

	test('a master rejection does not fail the local publish either', async () => {
		mockConfig = { ...mockConfig, masterUrl: 'https://master.example.com', masterJoinKey: 'jk', selfUrl: 'https://b.example.com' };
		mockFetchImpl = async () => ({ ok: false, status: 401 });
		await expect(roster.publishLocalSite({ gatewayPublicKey: GW_KEY })).resolves.toBeTruthy();
	});

	test('nothing is pushed before the gateway has published a key', async () => {
		mockConfig = { ...mockConfig, masterUrl: 'https://master.example.com', masterJoinKey: 'jk', selfUrl: 'https://b.example.com' };
		await roster.publishLocalSite({ name: 'Site B' });
		expect(mockFetchCalls.length).toBe(0);
	});
});

describe('adopting the roster downward', () => {
	const exported = [
		{ siteId: 1, slug: 'hub', name: 'Hub', gatewayPublicKey: 'aaa', gatewayEndpoint: 'hub:51820', isHub: true, exitOpen: true, country: 'US', lan168: '192.168.1.0/24' },
		{ siteId: 2, slug: 'office', name: 'Office', gatewayPublicKey: 'bbb', gatewayEndpoint: 'office:51820' },
		{ siteId: 4, slug: 'stale-self', name: 'stale', gatewayPublicKey: 'STALE', gatewayEndpoint: 'stale:1' }
	];

	test('sites from the export appear locally', async () => {
		const { adopted } = await roster.adoptRoster(exported);
		expect(adopted).toBe(2);
		const ids = (await roster.roster()).map((s) => Number(s.siteId));
		expect(ids).toEqual([1, 2]);
	});

	test('adopted rows carry everything a gateway needs', async () => {
		await roster.adoptRoster(exported);
		const hub = await roster.bySiteId(1);
		expect(hub.gatewayPublicKey).toBe('aaa');
		expect(hub.gatewayEndpoint).toBe('hub:51820');
		expect(hub.isHub).toBe(true);
		expect(hub.exitOpen).toBe(true);
		expect(hub.lan168).toBe('192.168.1.0/24');
	});

	// The local copy is always at least as fresh as the master's, because this
	// site's gateway publishes here first and pushes up second. Letting an
	// export overwrite it could blank a key that was just published.
	test('this site\'s own row is never overwritten by the export', async () => {
		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY, gatewayEndpoint: 'b.example.com:51820' });
		await roster.adoptRoster(exported);

		const own = await roster.bySiteId(4);
		expect(own.gatewayPublicKey).toBe(GW_KEY);
		expect(own.gatewayEndpoint).toBe('b.example.com:51820');
	});

	test('adopting again updates rather than duplicating', async () => {
		await roster.adoptRoster(exported);
		await roster.adoptRoster([{ ...exported[0], gatewayEndpoint: 'hub-new:51820' }]);

		expect(mockRows.sites.filter((s) => Number(s.siteId) === 1).length).toBe(1);
		expect((await roster.bySiteId(1)).gatewayEndpoint).toBe('hub-new:51820');
	});

	test('a site id with no address space is ignored, not adopted', async () => {
		await roster.adoptRoster([{ siteId: 999, slug: 'impossible' }]);
		expect(mockRows.sites.length).toBe(0);
	});

	test('an empty or missing roster is not an error', async () => {
		await expect(roster.adoptRoster(undefined)).resolves.toEqual({ adopted: 0 });
		await expect(roster.adoptRoster([])).resolves.toEqual({ adopted: 0 });
	});
});

describe('the hub', () => {
	test('only one site can be the hub at a time', async () => {
		await roster.adoptRoster([
			{ siteId: 1, slug: 'hub', isHub: true },
			{ siteId: 2, slug: 'office' }
		]);
		await roster.setHub(2);

		expect((await roster.bySiteId(1)).isHub).toBe(false);
		expect((await roster.bySiteId(2)).isHub).toBe(true);
		expect((await roster.roster()).filter((s) => s.isHub).length).toBe(1);
	});

	test('making a site the hub when it is not in the roster fails loudly', async () => {
		await expect(roster.setHub(9)).rejects.toThrow(/no site with id 9/);
	});

	describe('toPublicSafe (non-admin roster projection)', () => {
		test('strips WireGuard identity fields and exposes gatewayPublished', async () => {
			await roster.adoptRoster([
				{ siteId: 1, slug: 'hub', gatewayPublicKey: 'key-1', gatewayEndpoint: 'gw.example:51820', gatewayExitPublicKey: 'exit-key-1', exitOpen: true }
			]);
			const safe = roster.toPublicSafe(await roster.bySiteId(1));
			expect(safe.gatewayPublished).toBe(true);
			expect(safe.gatewayPublicKey).toBeUndefined();
			expect(safe.gatewayEndpoint).toBeUndefined();
			expect(safe.gatewayExitPublicKey).toBeUndefined();
			expect(safe.siteId).toBe(1);
			expect(safe.slug).toBe('hub');
		});

		test('reports not-published when the gateway has no key', async () => {
			await roster.adoptRoster([{ siteId: 2, slug: 'office' }]);
			const safe = roster.toPublicSafe(await roster.bySiteId(2));
			expect(safe.gatewayPublished).toBe(false);
			expect(safe.gatewayPublicKey).toBeUndefined();
		});
	});
});

describe('the resolver a gateway detects', () => {
	// Every site shipped with dnsHost null, so every client config went out
	// with no `DNS =` line at all: a device on the tunnel resolved against
	// whatever network it was physically sitting on, which resolves no
	// internal name. The gateway now offers what it found.
	test('is taken when the site has none', async () => {
		const site = await roster.publishLocalSite({
			gatewayPublicKey: GW_KEY, dnsHostDetected: '192.168.1.1'
		});
		expect(site.dnsHost).toBe('192.168.1.1');
	});

	// The critical half. reconcileMesh runs on a timer, so a gateway that
	// published its guess as `dnsHost` would overwrite the admin's answer
	// every few minutes -- worse than having no default at all.
	test('never overwrites one an admin has set', async () => {
		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY, dnsHost: '192.168.1.53' });
		const site = await roster.publishLocalSite({
			gatewayPublicKey: GW_KEY, dnsHostDetected: '192.168.1.1'
		});
		expect(site.dnsHost).toBe('192.168.1.53');
	});

	test('an explicit dnsHost in the same publish still wins', async () => {
		const site = await roster.publishLocalSite({
			gatewayPublicKey: GW_KEY, dnsHost: '192.168.1.53', dnsHostDetected: '192.168.1.1'
		});
		expect(site.dnsHost).toBe('192.168.1.53');
	});

	test('a gateway that detected nothing leaves the site alone', async () => {
		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY, dnsHost: '192.168.1.53' });
		const site = await roster.publishLocalSite({ gatewayPublicKey: GW_KEY, dnsHostDetected: null });
		expect(site.dnsHost).toBe('192.168.1.53');
	});

	// An admin clearing the field is a decision, not an absence -- but the
	// next detection may fill it again, which is the documented behaviour of
	// "leave blank and the gateway fills it in".
	test('clearing it lets the next detection fill it back in', async () => {
		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY, dnsHost: '192.168.1.53' });
		await roster.publishLocalSite({ gatewayPublicKey: GW_KEY, dnsHost: '' });
		const site = await roster.publishLocalSite({
			gatewayPublicKey: GW_KEY, dnsHostDetected: '192.168.1.1'
		});
		expect(site.dnsHost).toBe('192.168.1.1');
	});
});
