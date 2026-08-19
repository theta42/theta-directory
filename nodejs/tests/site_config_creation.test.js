'use strict';

// A node that has never joined anything must not end up with a
// /config/site.json.
//
// This is not a stylistic preference. theta-suite's setup.sh reads the
// PRESENCE of that file as "this node is already a spoke" and skips the join
// step, so anything that creates it early enough silently turns a spoke
// bring-up into a second master. That shipped in v2.24.0: the replication
// reconciler started persisting `ldapServerId` at boot, a fresh install
// defaults to isMaster:true, so the boot pass computed serverId 1 and wrote the
// file before setup.sh ever reached `site-join.js`. Two live sites both came up
// as master.
//
// Deliberately exercised against the REAL utils/site_config on a REAL temp
// file, with only the cluster-view lookup stubbed. A mocked site_config would
// have happily passed while production created the file -- which is the exact
// failure mode this whole area keeps repeating.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../utils/ldap_runtime_config', () => ({
	applyReplicationConfig: jest.fn(async () => ({ applied: true, changed: false, changes: [], note: 'ok' }))
}));
jest.mock('../models/site_spoke', () => ({ SiteSpoke: { list: async () => [] } }));

let configFile;

beforeEach(() => {
	jest.resetModules();
	configFile = path.join(
		fs.mkdtempSync(path.join(os.tmpdir(), 'theta-siteconfig-')),
		'site.json'
	);
	process.env.SITE_CONFIG_FILE = configFile;
	delete process.env.IS_MASTER;
	delete process.env.MASTER_URL;
	process.env.SITE_SLUG = 'site-pdp';
});

afterEach(() => {
	delete process.env.SITE_CONFIG_FILE;
	delete process.env.SITE_SLUG;
	try { fs.rmSync(path.dirname(configFile), { recursive: true, force: true }); } catch (e) {}
});

test('a boot reconcile on a fresh, never-joined node creates no site.json', async () => {
	const { reconcileReplication } = require('../utils/ldap_reconcile');

	expect(fs.existsSync(configFile)).toBe(false);
	await reconcileReplication('boot');
	// The whole bug in one assertion.
	expect(fs.existsSync(configFile)).toBe(false);
});

test('a spoke persists the server id the master assigned it', async () => {
	fs.writeFileSync(configFile, JSON.stringify({
		isMaster: false,
		masterUrl: 'https://master.example.com',
		masterJoinKey: 'stj_x',
		selfUrl: 'https://sso.spoke.example.com',
		siteSlug: 'site-pdp'
	}));

	const realFetch = global.fetch;
	global.fetch = async () => ({
		ok: true,
		json: async () => ({ status: 'ok', ldapServerId: 4, peers: [] })
	});
	try {
		const { reconcileReplication } = require('../utils/ldap_reconcile');
		await reconcileReplication('boot');
	} finally {
		global.fetch = realFetch;
	}

	expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).ldapServerId).toBe(4);
});

test('a master that already has an id on file is corrected to 1, without creating anything', async () => {
	// A promoted former spoke: it kept the id it held as a spoke.
	fs.writeFileSync(configFile, JSON.stringify({
		isMaster: true, masterUrl: '', siteSlug: 'site-pdp', ldapServerId: 3
	}));

	const { reconcileReplication } = require('../utils/ldap_reconcile');
	await reconcileReplication('promoted');

	expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).ldapServerId).toBe(1);
});
