'use strict';

// The upgrade path for models/index.js: ensureUniqueIndexes().
//
// A site running a build from before the index existed can already hold the
// bug the index prevents — two spokes with the same LDAP ServerID, written by
// two concurrent registrations on a node where the in-process mutex could not
// help (or before it existed). Adding a unique index to that database fails,
// so the duplicates have to be repaired first. If that repair is wrong the
// symptom is a site that boots fine and never replicates.
//
// These tests recreate that database by dropping the index and inserting the
// duplicate directly, which is the only way to produce the state now that the
// constraint is in place.

// Its own database. This suite deliberately drops the unique indexes and
// writes rows behind the model layer, which is exactly the state other suites
// assert is absent — jest runs suites in parallel workers against one sqlite
// file, so sharing it makes both flaky depending on interleaving.
process.env.app_orm__dialect = 'sqlite';
process.env.app_orm__storage = './config/test-unique-index-repair.sqlite';

require('./setup');
const { SiteSpoke } = require('../models/site_spoke');
const { Resource } = require('../models/resource');
const { ensureUniqueIndexes, repairDuplicateServerIds } = require('../models');

const sequelize = () => Resource.orm.adapters.sequelize.sequelize;
const table = () => sequelize().models.SiteSpoke.getTableName();

async function dropUniqueIndexes() {
	const qi = sequelize().getQueryInterface();
	for (const name of ['site_spoke_ldap_server_id_unique', 'site_spoke_endpoint_unique']) {
		try { await qi.removeIndex(table(), name); } catch (e) { /* not there */ }
	}
}

async function indexNames() {
	const idx = await sequelize().getQueryInterface().showIndex(table());
	return idx.map((i) => i.name);
}

// Bypasses the model layer on purpose: with the index dropped this is exactly
// what an older build's concurrent registration produced.
// createdAt/updatedAt are Sequelize's own columns and are NOT NULL; omitting
// them fails as "SequelizeUniqueConstraintError: Validation error" on sqlite,
// which points at entirely the wrong problem.
async function insertRaw({ id, endpoint, ldapServerId, created_on }) {
	const now = new Date();
	await sequelize().query(
		`INSERT INTO "${table()}" (id, endpoint, pushToken, ldapServerId, created_on, createdAt, updatedAt)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		{ replacements: [id, endpoint, 'tok-' + id, ldapServerId, created_on, now, now] }
	);
}

beforeEach(async () => {
	await dropUniqueIndexes();
	for (const s of await SiteSpoke.list()) await s.delete();
});

afterAll(async () => {
	for (const s of await SiteSpoke.list()) await s.delete();
	await ensureUniqueIndexes();
});

test('a database with duplicate ServerIDs is repaired and then constrained', async () => {
	await insertRaw({ id: 'a', endpoint: 'https://a.example.com', ldapServerId: 2, created_on: 100 });
	await insertRaw({ id: 'b', endpoint: 'https://b.example.com', ldapServerId: 2, created_on: 200 });

	await ensureUniqueIndexes();

	const rows = await SiteSpoke.list();
	const ids = rows.map((r) => r.ldapServerId).sort();
	expect(new Set(ids).size).toBe(2);

	// The index only exists if the repair actually cleared the duplicate --
	// addIndex would have thrown otherwise (and it is caught, so an unrepaired
	// database boots WITHOUT the constraint).
	expect(await indexNames()).toContain('site_spoke_ldap_server_id_unique');
});

test('the oldest registration keeps its id; the newer one moves', async () => {
	await insertRaw({ id: 'old', endpoint: 'https://old.example.com', ldapServerId: 3, created_on: 100 });
	await insertRaw({ id: 'new', endpoint: 'https://new.example.com', ldapServerId: 3, created_on: 500 });

	await repairDuplicateServerIds();

	const rows = await SiteSpoke.list();
	const byEndpoint = Object.fromEntries(rows.map((r) => [r.endpoint, r.ldapServerId]));
	expect(byEndpoint['https://old.example.com']).toBe(3);
	expect(byEndpoint['https://new.example.com']).not.toBe(3);
});

// 1 is the master's. Handing it to a spoke is the same collision one level up.
test('a reassignment never hands out the master reserved id 1', async () => {
	await insertRaw({ id: 'x', endpoint: 'https://x.example.com', ldapServerId: 4, created_on: 100 });
	await insertRaw({ id: 'y', endpoint: 'https://y.example.com', ldapServerId: 4, created_on: 200 });

	await repairDuplicateServerIds();

	const ids = (await SiteSpoke.list()).map((r) => r.ldapServerId);
	expect(ids).not.toContain(1);
});

test('a reassignment does not collide with an id already in use', async () => {
	await insertRaw({ id: 'p', endpoint: 'https://p.example.com', ldapServerId: 2, created_on: 100 });
	await insertRaw({ id: 'q', endpoint: 'https://q.example.com', ldapServerId: 2, created_on: 200 });
	await insertRaw({ id: 'r', endpoint: 'https://r.example.com', ldapServerId: 3, created_on: 300 });

	await repairDuplicateServerIds();

	const ids = (await SiteSpoke.list()).map((r) => r.ldapServerId);
	expect(new Set(ids).size).toBe(3);
	expect(ids).toContain(2);
	expect(ids).toContain(3);
});

test('three rows sharing one id all end up distinct', async () => {
	for (const [n, t] of [['a', 100], ['b', 200], ['c', 300]]) {
		await insertRaw({ id: n, endpoint: `https://${n}.example.com`, ldapServerId: 5, created_on: t });
	}

	await repairDuplicateServerIds();

	const ids = (await SiteSpoke.list()).map((r) => r.ldapServerId);
	expect(new Set(ids).size).toBe(3);
});

// A spoke that has registered but not yet been assigned an id is not a
// duplicate, however many of them there are.
test('rows with no ServerID are left alone', async () => {
	await insertRaw({ id: 'n1', endpoint: 'https://n1.example.com', ldapServerId: null, created_on: 100 });
	await insertRaw({ id: 'n2', endpoint: 'https://n2.example.com', ldapServerId: null, created_on: 200 });

	await repairDuplicateServerIds();

	const ids = (await SiteSpoke.list()).map((r) => r.ldapServerId);
	expect(ids.filter((i) => !i).length).toBe(2);
});

test('a clean database is left untouched', async () => {
	await insertRaw({ id: 'c1', endpoint: 'https://c1.example.com', ldapServerId: 2, created_on: 100 });
	await insertRaw({ id: 'c2', endpoint: 'https://c2.example.com', ldapServerId: 3, created_on: 200 });

	await repairDuplicateServerIds();

	const rows = await SiteSpoke.list();
	const byEndpoint = Object.fromEntries(rows.map((r) => [r.endpoint, r.ldapServerId]));
	expect(byEndpoint).toEqual({ 'https://c1.example.com': 2, 'https://c2.example.com': 3 });
});

// Booting twice must not thrash: the second pass sees the index and skips.
test('ensureUniqueIndexes is idempotent', async () => {
	await insertRaw({ id: 'i1', endpoint: 'https://i1.example.com', ldapServerId: 2, created_on: 100 });

	await ensureUniqueIndexes();
	const first = await indexNames();
	await ensureUniqueIndexes();
	const second = await indexNames();

	expect(second.sort()).toEqual(first.sort());
	expect(first).toContain('site_spoke_ldap_server_id_unique');
	expect(first).toContain('site_spoke_endpoint_unique');
});

// The constraint has to survive the repair, not just be added by it.
test('after repair the database rejects a new duplicate', async () => {
	await insertRaw({ id: 'd1', endpoint: 'https://d1.example.com', ldapServerId: 2, created_on: 100 });
	await insertRaw({ id: 'd2', endpoint: 'https://d2.example.com', ldapServerId: 2, created_on: 200 });
	await ensureUniqueIndexes();

	const taken = (await SiteSpoke.list())[0].ldapServerId;
	await expect(SiteSpoke.create({
		id: 'd3', endpoint: 'https://d3.example.com', pushToken: 't',
		created_on: 300, ldapServerId: taken
	})).rejects.toThrow(/unique|constraint|validation/i);
});
