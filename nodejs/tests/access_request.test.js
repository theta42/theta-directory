'use strict';

// Self-service access requests, end to end: request -> approve -> the grant is
// real (visible through /api/discovery/me), plus the guards that keep the flow
// from being abused or double-applied.
//
// The seed `test` user is in app_sso_admin, so it is both the requester and an
// eligible approver here. That is unusual in production but exactly what makes
// a single-user test able to walk the whole loop.

const { login, request, app } = require('./setup');

let token;
let siteSlug;
let hostSlug;
let hostId;
let accessGroupCn;

// Unique per run: these create real LDAP groups and SQL rows, and a rerun must
// not collide with the previous run's leftovers.
const stamp = Date.now().toString(36);

beforeAll(async () => {
	token = await login();

	siteSlug = `artest-site-${stamp}`;
	const site = await request(app)
		.post('/api/directory-admin/resources')
		.set('auth-token', token)
		.send({ name: `AR Test Site ${stamp}`, slug: siteSlug, kind: 'site' });
	expect(site.status).toBe(200);

	hostSlug = `artest-host-${stamp}`;
	const host = await request(app)
		.post('/api/directory-admin/resources')
		.set('auth-token', token)
		.send({
			name: `AR Test Host ${stamp}`,
			slug: hostSlug,
			kind: 'host',
			parentSlug: siteSlug,
			metadata: { ip: '10.99.99.9' },
		});
	expect(host.status).toBe(200);
	hostId = host.body.results.id;

	// Creating a host auto-provisions <site>_host_<slug>_access / _admin
	// (docs/GROUPS.md §2 — the kind is part of the name).
	accessGroupCn = `${siteSlug}_host_${hostSlug}_access`;
	const adminGroupCn = `${siteSlug}_host_${hostSlug}_admin`;

	// The creator is seeded into both groups -- groupOfNames requires at least
	// one member, so Group.add puts the owner's DN there -- and _admin is nested
	// into _access, so membership of either grants access. A user who already
	// has access cannot request it (correctly), so step out of both to be a
	// legitimate requester. Removing only _access would leave the grant intact
	// through the nesting, which is exactly the kind of thing these tests exist
	// to catch.
	for (const cn of [adminGroupCn, accessGroupCn]) {
		await request(app)
			.delete(`/api/group/${encodeURIComponent(cn)}/test`)
			.set('auth-token', token);
	}
});

describe('Access requests — the request half', () => {
	let requestId;

	test('POST /api/access-requests creates a pending request on the member group', async () => {
		const res = await request(app)
			.post('/api/access-requests')
			.set('auth-token', token)
			.send({ slug: hostSlug, note: 'need it for testing' });

		expect(res.status).toBe(200);
		expect(res.body.results).toBeDefined();
		expect(res.body.results.status).toBe('pending');
		expect(res.body.results.uid).toBe('test');
		// Must target the _access group, never the _admin one: asking to use a
		// resource may not silently escalate to administering it.
		expect(res.body.results.groupCn).toBe(accessGroupCn);
		requestId = res.body.results.id;
	});

	test('a second request for the same resource is rejected', async () => {
		const res = await request(app)
			.post('/api/access-requests')
			.set('auth-token', token)
			.send({ slug: hostSlug });
		expect(res.status).toBe(409);
	});

	test('GET /api/access-requests/mine lists it with the resource attached', async () => {
		const res = await request(app).get('/api/access-requests/mine').set('auth-token', token);
		expect(res.status).toBe(200);
		const found = res.body.results.find(r => r.id === requestId);
		expect(found).toBeDefined();
		expect(found.resource.slug).toBe(hostSlug);
	});

	test('GET /api/access-requests shows it to an approver', async () => {
		const res = await request(app).get('/api/access-requests').set('auth-token', token);
		expect(res.status).toBe(200);
		expect(res.body.results.some(r => r.id === requestId)).toBe(true);
	});

	test('requesting an unknown resource is a 404', async () => {
		const res = await request(app)
			.post('/api/access-requests')
			.set('auth-token', token)
			.send({ slug: `no-such-resource-${stamp}` });
		expect(res.status).toBe(404);
	});
});

describe('Access requests — approval actually grants', () => {
	let requestId;

	beforeAll(async () => {
		const mine = await request(app).get('/api/access-requests/mine').set('auth-token', token);
		const pending = mine.body.results.find(r => r.groupCn === accessGroupCn && r.status === 'pending');
		requestId = pending && pending.id;
		expect(requestId).toBeDefined();
	});

	test('the resource is NOT in /api/discovery/me before approval', async () => {
		const res = await request(app).get('/api/discovery/me').set('auth-token', token);
		expect(res.status).toBe(200);
		expect(res.body.results.some(r => r.id === hostId)).toBe(false);
	});

	test('POST /:id/approve marks it approved', async () => {
		const res = await request(app)
			.post(`/api/access-requests/${requestId}/approve`)
			.set('auth-token', token)
			.send({ decisionNote: 'ok' });
		expect(res.status).toBe(200);
		expect(res.body.results.status).toBe('approved');
		expect(res.body.results.decidedBy).toBe('test');
	});

	test('approving twice is rejected', async () => {
		const res = await request(app)
			.post(`/api/access-requests/${requestId}/approve`)
			.set('auth-token', token)
			.send({});
		expect(res.status).toBe(409);
	});

	// The payoff, and the regression guard for the user.groups bug: /me resolved
	// groups off req.user.groups, which does not exist on a User (it carries
	// memberOf), so this endpoint used to return only isPublic resources no
	// matter what the caller was actually a member of.
	test('the resource IS in /api/discovery/me after approval', async () => {
		const res = await request(app).get('/api/discovery/me').set('auth-token', token);
		expect(res.status).toBe(200);
		const found = res.body.results.find(r => r.id === hostId);
		expect(found).toBeDefined();
		// And it answers "how do I reach it" rather than just naming the thing.
		expect(found.resolvedAddress).toBe('10.99.99.9');
	});

	test('an already-granted resource cannot be requested again', async () => {
		const res = await request(app)
			.post('/api/access-requests')
			.set('auth-token', token)
			.send({ slug: hostSlug });
		expect(res.status).toBe(409);
	});
});

describe('Admin access visibility', () => {
	test('GET /api/directory-admin/access-summary counts the host\'s groups + members', async () => {
		const res = await request(app)
			.get('/api/directory-admin/access-summary')
			.set('auth-token', token);
		expect(res.status).toBe(200);
		const summary = res.body.results[hostId];
		expect(summary).toBeDefined();
		// _access and _admin were both auto-created and linked.
		expect(summary.groups.length).toBe(2);
		expect(summary.groups.every(g => g.exists)).toBe(true);
		// The approval above put `test` in the access group.
		expect(summary.memberCount).toBeGreaterThanOrEqual(1);
	});

	test('GET /api/directory-admin/user-access/:uid answers the reverse question', async () => {
		const res = await request(app)
			.get('/api/directory-admin/user-access/test')
			.set('auth-token', token);
		expect(res.status).toBe(200);
		expect(res.body.results.uid).toBe('test');
		const entry = res.body.results.resources.find(r => r.id === hostId);
		expect(entry).toBeDefined();
		expect(entry.groupCn).toBe(accessGroupCn);
	});

	test('user-access for an unknown uid is a 404', async () => {
		const res = await request(app)
			.get('/api/directory-admin/user-access/definitely-not-a-user')
			.set('auth-token', token);
		expect(res.status).toBe(404);
	});
});

describe('Access requests — withdrawal', () => {
	test('a requester can withdraw their own pending request', async () => {
		// A second resource, so this does not disturb the approved one above.
		const slug = `artest-host2-${stamp}`;
		const host = await request(app)
			.post('/api/directory-admin/resources')
			.set('auth-token', token)
			.send({ name: `AR Test Host2 ${stamp}`, slug, kind: 'host', parentSlug: siteSlug });
		expect(host.status).toBe(200);

		// Same as the top-level setup: step out of the auto-created groups the
		// creator is seeded into (docs/GROUPS.md §2 — kind is part of the name),
		// or this is a request for access already held.
		for (const cn of [`${siteSlug}_host_${slug}_admin`, `${siteSlug}_host_${slug}_access`]) {
			await request(app)
				.delete(`/api/group/${encodeURIComponent(cn)}/test`)
				.set('auth-token', token);
		}

		const created = await request(app)
			.post('/api/access-requests')
			.set('auth-token', token)
			.send({ slug });
		expect(created.status).toBe(200);

		const res = await request(app)
			.delete(`/api/access-requests/${created.body.results.id}`)
			.set('auth-token', token);
		expect(res.status).toBe(200);
		expect(res.body.results.status).toBe('cancelled');
	});
});
