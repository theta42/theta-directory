'use strict';

// The 3+-site promotion handoff (utils/site_promote.js).
//
// The bug this covers: promotion worked for a two-site cluster and silently
// orphaned every additional site. The promoted node was a spoke, so its own
// SiteSpoke registry was empty; nothing inherited the old master's registry,
// and sibling spokes kept replicating from the node that had just been
// demoted. The two-site e2e passed throughout, because the demoted master
// re-registers itself.

const mockSpokes = [];

jest.mock('../models/site_spoke', () => {
	const makeRow = (data) => {
		const row = { ...data };
		row.update = async (patch) => { Object.assign(row, patch); return row; };
		return row;
	};
	return {
		SiteSpoke: {
			generatePushToken: () => 'generated-token',
			list: async () => mockSpokes.slice(),
			create: async (d) => { const row = makeRow(d); mockSpokes.push(row); return row; }
		}
	};
});

jest.mock('../utils/ldap_replication', () => ({
	nextFreeLdapServerId: async () => {
		const used = new Set(mockSpokes.map(s => s.ldapServerId).filter(Boolean));
		for (let i = 2; i <= 4094; i++) if (!used.has(i)) return i;
		throw new Error('exhausted');
	}
}));

const { adoptInheritedSpokes } = require('../utils/site_promote');

beforeEach(() => { mockSpokes.length = 0; });

function recordingFetch(behavior = () => ({ ok: true, status: 200 })) {
	const calls = [];
	const fn = async (url, opts) => {
		calls.push({ url, opts, body: JSON.parse(opts.body), auth: opts.headers.Authorization });
		return behavior(url, opts);
	};
	fn.calls = calls;
	return fn;
}

test('adopts the inherited registry and re-points every sibling', async () => {
	const fetchImpl = recordingFetch();
	const res = await adoptInheritedSpokes({
		inheritedSpokes: [
			{ endpoint: 'http://site-c:3001', siteSlug: 'site_c', pushToken: 'tok-c', ldapServerId: 3 },
			{ endpoint: 'http://site-d:3001', siteSlug: 'site_d', pushToken: 'tok-d', ldapServerId: 4 }
		],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'stj_new',
		fetchImpl
	});

	expect(res.adopted).toBe(2);
	expect(res.repointed).toBe(2);
	expect(mockSpokes.map(s => s.endpoint)).toEqual(['http://site-c:3001', 'http://site-d:3001']);

	// Each spoke is called with the token IT already trusts, not a new one.
	expect(fetchImpl.calls[0].auth).toBe('Bearer tok-c');
	expect(fetchImpl.calls[1].auth).toBe('Bearer tok-d');
	expect(fetchImpl.calls[0].url).toBe('http://site-c:3001/api/site/master-changed');
	expect(fetchImpl.calls[0].body).toEqual({
		newMasterUrl: 'http://site-b:3001',
		newJoinKey: 'stj_new',
		selfEndpoint: 'http://site-c:3001'
	});
});

test('never registers the promoting node as its own spoke', async () => {
	const fetchImpl = recordingFetch();
	const res = await adoptInheritedSpokes({
		inheritedSpokes: [
			{ endpoint: 'http://site-b:3001/', siteSlug: 'site_b', pushToken: 'tok-b', ldapServerId: 2 },
			{ endpoint: 'http://site-c:3001', siteSlug: 'site_c', pushToken: 'tok-c', ldapServerId: 3 }
		],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'stj_new',
		fetchImpl
	});

	expect(res.adopted).toBe(1);
	expect(mockSpokes.map(s => s.endpoint)).toEqual(['http://site-c:3001']);
});

// One unreachable sibling must not abort the promotion or block the others.
test('an unreachable sibling is reported, not fatal', async () => {
	const fetchImpl = recordingFetch((url) => {
		if (url.startsWith('http://site-c')) throw new Error('ECONNREFUSED');
		return { ok: true, status: 200 };
	});

	const res = await adoptInheritedSpokes({
		inheritedSpokes: [
			{ endpoint: 'http://site-c:3001', pushToken: 'tok-c', ldapServerId: 3 },
			{ endpoint: 'http://site-d:3001', pushToken: 'tok-d', ldapServerId: 4 }
		],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'stj_new',
		fetchImpl
	});

	expect(res.adopted).toBe(2);       // both are in the registry either way
	expect(res.repointed).toBe(1);     // only D actually took the re-point
	const c = res.results.find(r => r.endpoint === 'http://site-c:3001');
	expect(c.note).toMatch(/re-point failed/);
});

test('a rejected re-point is reported with its status', async () => {
	const fetchImpl = recordingFetch(() => ({ ok: false, status: 401 }));
	const res = await adoptInheritedSpokes({
		inheritedSpokes: [{ endpoint: 'http://site-c:3001', pushToken: 'stale', ldapServerId: 3 }],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'stj_new',
		fetchImpl
	});
	expect(res.repointed).toBe(0);
	expect(res.results[0].note).toMatch(/HTTP 401/);
});

test('inherited ldapServerIds are preserved when free', async () => {
	const fetchImpl = recordingFetch();
	await adoptInheritedSpokes({
		inheritedSpokes: [{ endpoint: 'http://site-c:3001', pushToken: 't', ldapServerId: 7 }],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'k',
		fetchImpl
	});
	expect(mockSpokes[0].ldapServerId).toBe(7);
});

// The promoted node now owns ServerID 1; an inherited spoke that used to hold
// it (it was the master) must be moved off, not left colliding.
test('an inherited ldapServerId of 1 is reassigned', async () => {
	const fetchImpl = recordingFetch();
	await adoptInheritedSpokes({
		inheritedSpokes: [{ endpoint: 'http://old-master:3001', pushToken: 't', ldapServerId: 1 }],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'k',
		fetchImpl
	});
	expect(mockSpokes[0].ldapServerId).not.toBe(1);
	expect(mockSpokes[0].ldapServerId).toBeGreaterThanOrEqual(2);
});

test('two inherited spokes claiming the same id do not both keep it', async () => {
	const fetchImpl = recordingFetch();
	await adoptInheritedSpokes({
		inheritedSpokes: [
			{ endpoint: 'http://site-c:3001', pushToken: 't1', ldapServerId: 5 },
			{ endpoint: 'http://site-d:3001', pushToken: 't2', ldapServerId: 5 }
		],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'k',
		fetchImpl
	});
	const ids = mockSpokes.map(s => s.ldapServerId);
	expect(new Set(ids).size).toBe(2);
	expect(ids).toContain(5);
});

test('an existing local row for the same endpoint is updated, not duplicated', async () => {
	mockSpokes.push({
		endpoint: 'http://site-c:3001', pushToken: 'old', ldapServerId: 9,
		update: async function (patch) { Object.assign(this, patch); return this; }
	});
	const fetchImpl = recordingFetch();
	const res = await adoptInheritedSpokes({
		inheritedSpokes: [{ endpoint: 'http://site-c:3001', pushToken: 'inherited', ldapServerId: 3 }],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'k',
		fetchImpl
	});
	expect(mockSpokes.length).toBe(1);
	expect(mockSpokes[0].pushToken).toBe('inherited');
	expect(res.adopted).toBe(1);
});

test('an empty handover is a clean no-op', async () => {
	const fetchImpl = recordingFetch();
	const res = await adoptInheritedSpokes({ inheritedSpokes: [], selfUrl: 'http://b:3001', promotionKey: 'k', fetchImpl });
	expect(res).toEqual({ adopted: 0, repointed: 0, results: [] });
	expect(fetchImpl.calls.length).toBe(0);
});

// Promotion with an unreachable old master: nothing is inherited, so the
// siblings stay orphaned and the operator has to be told rather than the
// promotion silently claiming success.
test('without a promotion key the rows are still adopted but not re-pointed', async () => {
	const fetchImpl = recordingFetch();
	const res = await adoptInheritedSpokes({
		inheritedSpokes: [{ endpoint: 'http://site-c:3001', pushToken: 't', ldapServerId: 3 }],
		selfUrl: 'http://site-b:3001',
		promotionKey: null,
		fetchImpl
	});
	expect(res.adopted).toBe(1);
	expect(res.repointed).toBe(0);
	expect(res.results[0].note).toMatch(/not re-pointed/);
	expect(fetchImpl.calls.length).toBe(0);
});

// The re-point HTTP call must NOT run while the registration lock is held.
// POST /api/site/master-changed makes the spoke turn around and call this
// node's POST /api/site/spokes, which takes the same lock — holding it across
// the outbound call deadlocks until the 15s abort fires, and every sibling
// comes back "re-point failed: This operation was aborted". (Exactly what the
// three-site e2e reported when the lock was first added.)
test('the registration lock is released before any spoke is re-pointed', async () => {
	const { withLock } = require('../utils/mutex');
	let lockHeldDuringRepoint = null;

	const fetchImpl = async () => {
		// Stand-in for the spoke calling back into POST /api/site/spokes: if
		// the lock is still held, this never resolves and the real thing
		// times out.
		let acquired = false;
		const probe = withLock('site-spoke-register', async () => { acquired = true; });
		const timeout = new Promise((resolve) => setTimeout(resolve, 200));
		await Promise.race([probe, timeout]);
		lockHeldDuringRepoint = !acquired;
		return { ok: true, status: 200 };
	};

	await adoptInheritedSpokes({
		inheritedSpokes: [{ endpoint: 'http://site-c:3001', pushToken: 'tok-c', ldapServerId: 3 }],
		selfUrl: 'http://site-b:3001',
		promotionKey: 'stj_new',
		fetchImpl
	});

	expect(lockHeldDuringRepoint).toBe(false);
});
