'use strict';

// Serialization behavior of the replication reconciler.
//
// The bug this pins: a trigger arriving while a pass was already running used
// to get the in-flight promise handed back to it and nothing else. That looks
// like harmless coalescing but is data loss — the running pass read the spoke
// registry BEFORE that change existed, so it cannot possibly have applied it.
// Two spokes registering back to back was enough, and the second one's peer
// then sat unapplied until the ten-minute sweep. Found by driving the real UI
// (two registrations in quick succession); the e2e missed it because its
// registrations were spread out in time.

// jest.mock factories may only reference out-of-scope variables whose names
// start with `mock`, so the recorder and the gate carry that prefix.
const mockApplyCalls = [];
const mockSpokes = [];
let mockApplyGate = null;
let releaseApply;

jest.mock('../utils/ldap_runtime_config', () => ({
	applyReplicationConfig: jest.fn(async (desired) => {
		mockApplyCalls.push(desired);
		if (mockApplyGate) await mockApplyGate;
		return { applied: true, changed: false, changes: [], note: 'ok' };
	})
}));

// A master with a registry that GROWS between passes, which is the real
// scenario: the second registration lands while the first pass is mid-flight.
jest.mock('../models/site_spoke', () => ({
	SiteSpoke: { list: async () => mockSpokes.slice() }
}));

jest.mock('../utils/site_config', () => ({
	get: () => ({ isMaster: true, siteSlug: 'site_main' }),
	configFile: () => '/tmp/ldap-reconcile-test-site.json'
}));

const { reconcileReplication } = require('../utils/ldap_reconcile');

beforeEach(() => {
	mockApplyCalls.length = 0;
	mockSpokes.length = 0;
	mockApplyGate = null;
});

test('a trigger arriving mid-pass is re-run, not dropped', async () => {
	mockSpokes.push({ ldapServerId: 2, endpoint: 'https://a.example.com' });

	// Hold the first pass open inside applyReplicationConfig.
	mockApplyGate = new Promise((resolve) => { releaseApply = resolve; });

	const first = reconcileReplication('spoke-registered-a');
	// Let the first pass reach the gate (it has already read the registry).
	await new Promise((r) => setImmediate(r));

	// Second spoke registers WHILE the first pass is still running.
	mockSpokes.push({ ldapServerId: 3, endpoint: 'https://b.example.com' });
	const second = reconcileReplication('spoke-registered-b');

	releaseApply();
	await Promise.all([first, second]);
	// The re-run pass is scheduled from the first one's completion.
	await new Promise((r) => setImmediate(r));

	// Two passes: the original, plus one that can see the second spoke.
	expect(mockApplyCalls.length).toBe(2);
	const lastPeers = mockApplyCalls[mockApplyCalls.length - 1].peers.map((p) => p.ldapHost);
	// Peers are dialled over the mesh (plain LDAP at the site's mesh address),
	// not the public endpoint.
	expect(lastPeers).toContain('ldap://10.2.0.2:389');
	expect(lastPeers).toContain('ldap://10.3.0.2:389');
});

test('several triggers during one pass collapse into a single re-run', async () => {
	mockSpokes.push({ ldapServerId: 2, endpoint: 'https://a.example.com' });
	mockApplyGate = new Promise((resolve) => { releaseApply = resolve; });

	const first = reconcileReplication('one');
	await new Promise((r) => setImmediate(r));

	const rest = [
		reconcileReplication('two'),
		reconcileReplication('three'),
		reconcileReplication('four')
	];

	releaseApply();
	await Promise.all([first, ...rest]);
	await new Promise((r) => setImmediate(r));

	// Serialized and coalesced: one extra pass covers all three, not three.
	expect(mockApplyCalls.length).toBe(2);
});

test('sequential triggers each get their own pass', async () => {
	mockSpokes.push({ ldapServerId: 2, endpoint: 'https://a.example.com' });

	await reconcileReplication('first');
	await reconcileReplication('second');

	expect(mockApplyCalls.length).toBe(2);
});

test('a pass that throws still releases the lock for the next trigger', async () => {
	const { applyReplicationConfig } = require('../utils/ldap_runtime_config');
	applyReplicationConfig.mockImplementationOnce(async () => { throw new Error('slapd unreachable'); });

	await expect(reconcileReplication('failing')).resolves.toMatchObject({ applied: false });
	// Not wedged: the next trigger runs.
	await reconcileReplication('recovery');
	expect(mockApplyCalls.length).toBeGreaterThanOrEqual(1);
});
