'use strict';

// Nested groups: the API for putting a group inside a group, the cycle guard,
// and the thing that makes it worth doing -- membership resolving transitively
// through the chain.
//
// Fixture note that is easy to get wrong: groupOfNames requires at least one
// member, so whoever creates a group is seeded into it. `test` creates all
// three groups here and would therefore be a *direct* member of each, which
// would make "resolved via nesting" indistinguishable from "was already in it".
// Setup below strips that back so test's only direct membership is the
// innermost group -- and the strip has to happen after nesting, or removing the
// sole member would violate the objectClass.

const { login, request, app } = require('./setup');

let token;
const stamp = Date.now().toString(36);
const A = `nesttest-a-${stamp}`; // outermost
const B = `nesttest-b-${stamp}`; // middle
const C = `nesttest-c-${stamp}`; // innermost, holds the user
// A second group nested into A purely so that un-nesting B later does not
// empty A -- groupOfNames requires at least one member, and the API correctly
// refuses (409) rather than leaving an invalid entry behind.
const D = `nesttest-d-${stamp}`;

async function nest(parent, child) {
	return request(app).put(`/api/group/${parent}/nested/${child}`).set('auth-token', token).send({});
}

beforeAll(async () => {
	token = await login();

	for (const cn of [A, B, C, D]) {
		const res = await request(app)
			.post('/api/group')
			.set('auth-token', token)
			.send({ name: cn, description: `nesting test ${cn}` });
		expect([200, 201]).toContain(res.status);
	}

	expect((await nest(A, B)).status).toBe(200);
	expect((await nest(B, C)).status).toBe(200);
	expect((await nest(A, D)).status).toBe(200);

	// Now that A holds B and B holds C, neither would be left memberless.
	for (const cn of [A, B]) {
		const res = await request(app).delete(`/api/group/${cn}/test`).set('auth-token', token);
		expect(res.status).toBe(200);
	}
});

describe('Nested groups — API guards', () => {
	test('nesting the same pair twice is a 409, not a duplicate', async () => {
		const res = await nest(A, B);
		expect(res.status).toBe(409);
	});

	test('a group cannot contain itself', async () => {
		const res = await nest(A, A);
		expect(res.status).toBe(400);
	});

	// The guard that matters: without it the resolver would silently return a
	// depth-capped answer instead of an error anyone would notice.
	test('a direct cycle is refused (A contains B, so B may not contain A)', async () => {
		const res = await nest(B, A);
		expect(res.status).toBe(409);
		expect(res.body.message).toMatch(/loop/i);
	});

	test('an indirect cycle is refused too (A>B>C, so C may not contain A)', async () => {
		const res = await nest(C, A);
		expect(res.status).toBe(409);
	});
});

describe('Nested groups — resolution', () => {
	test('membership resolves through the whole chain', async () => {
		const res = await request(app).get('/api/group?member=test').set('auth-token', token);
		expect(res.status).toBe(200);
		expect(res.body.results).toContain(C); // direct
		expect(res.body.results).toContain(B); // via C
		expect(res.body.results).toContain(A); // via B -> C
	});

	test('GET /:group/effective separates direct members from nested ones', async () => {
		const res = await request(app).get(`/api/group/${A}/effective`).set('auth-token', token);
		expect(res.status).toBe(200);
		const { direct, nestedGroups, effective } = res.body.results;

		expect(nestedGroups.map(g => g.cn)).toContain(B);
		// `direct` is users only -- a nested group must never be reported as one.
		expect(direct.every(dn => !/,ou=groups,/i.test(dn))).toBe(true);
		// test is not listed on A at all, yet is effectively a member two levels down.
		expect(direct.some(dn => /cn=test,/i.test(dn))).toBe(false);
		expect(effective.some(dn => /cn=test,/i.test(dn))).toBe(true);
	});
});

describe('Nested groups — un-nesting', () => {
	test('DELETE removes the nesting and the membership it carried', async () => {
		// Before: A holds B (which holds C, which holds test) and D.
		const before = await request(app).get(`/api/group/${A}/effective`).set('auth-token', token);
		expect(before.body.results.nestedGroups.map(g => g.cn)).toContain(B);
		expect(before.body.results.effective.some(dn => /cn=test,/i.test(dn))).toBe(true);

		const res = await request(app)
			.delete(`/api/group/${A}/nested/${B}`)
			.set('auth-token', token);
		expect(res.status).toBe(200);

		const after = await request(app).get(`/api/group/${A}/effective`).set('auth-token', token);
		expect(after.body.results.nestedGroups.map(g => g.cn)).not.toContain(B);
		expect(after.body.results.nestedGroups.map(g => g.cn)).toContain(D); // untouched

		// test still resolves to B and C directly/through C; only the A path via
		// B is gone. It is deliberately NOT asserted that test loses A entirely:
		// D is also nested in A and test created D, so that path remains -- which
		// is itself a fair illustration of why "who can reach this" has to be
		// computed rather than eyeballed.
		const groups = await request(app).get('/api/group?member=test').set('auth-token', token);
		expect(groups.body.results).toContain(C);
		expect(groups.body.results).toContain(B);
	});

	test('un-nesting the last member is refused rather than emptying the group', async () => {
		// B now holds only C. Removing it would leave B with no members at all,
		// which groupOfNames forbids.
		const res = await request(app)
			.delete(`/api/group/${B}/nested/${C}`)
			.set('auth-token', token);
		expect(res.status).toBe(409);
		expect(res.body.message).toMatch(/at least one member/i);
	});
});
