'use strict';

// findAncestorSiteSlug has no LDAP dependency (unlike most of this test
// suite, which needs a live LDAP server) -- it's pure Resource/ResourceEdge
// graph traversal against the ORM, so it's tested directly here rather than
// through the (LDAP-gated) directory-admin HTTP routes.

const { initORM } = require('../models');
const { Resource, ResourceEdge } = require('../models/resource');

const marker = 'test_site_slug_' + Date.now();
const created = [];

async function makeResource(kind, name) {
	const r = await Resource.create({ kind, name, slug: `${marker}_${name}` });
	created.push(r);
	return r;
}

beforeAll(async () => {
	await initORM();
});

afterAll(async () => {
	for (const r of created) {
		try { await r.delete(); } catch (_) {}
	}
});

describe('Resource.findAncestorSiteSlug', () => {
	test('returns the direct parent site\'s slug', async () => {
		const site = await makeResource('site', 'site-direct');
		const host = await makeResource('host', 'host-direct');
		await ResourceEdge.create({ parentId: site.id, childId: host.id, relation: 'hosts' });

		await expect(Resource.findAncestorSiteSlug(host.id)).resolves.toBe(site.slug);
	});

	test('walks up through an intermediate host to find the owning site', async () => {
		const site = await makeResource('site', 'site-nested');
		const host = await makeResource('host', 'host-nested');
		const service = await makeResource('service', 'service-nested');
		await ResourceEdge.create({ parentId: site.id, childId: host.id, relation: 'hosts' });
		await ResourceEdge.create({ parentId: host.id, childId: service.id, relation: 'hosts' });

		await expect(Resource.findAncestorSiteSlug(service.id)).resolves.toBe(site.slug);
	});

	test('returns null for a top-level resource with no site ancestor', async () => {
		const host = await makeResource('host', 'host-orphan');

		await expect(Resource.findAncestorSiteSlug(host.id)).resolves.toBeNull();
	});

	test('does not loop forever on a cyclic parent chain', async () => {
		const a = await makeResource('host', 'host-cycle-a');
		const b = await makeResource('host', 'host-cycle-b');
		await ResourceEdge.create({ parentId: a.id, childId: b.id, relation: 'hosts' });
		await ResourceEdge.create({ parentId: b.id, childId: a.id, relation: 'hosts' });

		await expect(Resource.findAncestorSiteSlug(a.id)).resolves.toBeNull();
	});
});
