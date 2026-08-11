'use strict';

// Parser + planner + applier for directory migration (utils/ldif.js,
// utils/ldif_import.js). Deliberately free of ./setup: none of this touches
// LDAP, Redis or the database -- applyPlan takes its models as an argument
// precisely so the decision logic can be tested without a directory to write to.

const { parseLDIF, one, all, parentDN } = require('../utils/ldif');
const { detectProfile, buildPlan, redactPlan, applyPlan, passwordScheme } = require('../utils/ldif_import');

// A miniature of a real slapcat dump: operational attributes on every entry,
// a folded line, a base64 value, an MD5 password, a locked account, a personal
// posixGroup, a permission groupOfNames and one nested group member.
const SAMPLE = `dn: dc=example,dc=com
objectClass: top
objectClass: dcObject
objectClass: organization
o: Example
dc: example
structuralObjectClass: organization
entryUUID: 034e79a2-eacd-1039-8231-11d8eea17c06
createTimestamp: 20200223211259Z

dn: cn=jdoe,ou=people,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: posixAccount
objectClass: ldapPublicKey
objectClass: top
cn: jdoe
uid: jdoe
sn: Doe
givenName: Jane
mail: jane@example.com
mobile: +15550100
uidNumber: 1500
gidNumber: 1500
loginShell: /bin/bash
homeDirectory: /home/jdoe
userPassword:: e1NTSEE1MTJ9YWJjZGVm
sshPublicKey: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI
 EXAMPLEKEY jane@example.com
structuralObjectClass: inetOrgPerson
entryUUID: aaa5687e-2398-103a-94d8-3f13c872b570
memberOf: cn=staff,ou=groups,dc=example,dc=com

dn: cn=bsmith,ou=people,dc=example,dc=com
objectClass: inetOrgPerson
objectClass: posixAccount
objectClass: top
cn: Bob Smith
uid: bsmith
sn: Smith
givenName: Bob
uidNumber: 1501
gidNumber: 1501
userPassword: {MD5}LcL7AvB5zrMKyiDRm26/8w==
pwdAccountLockedTime: 00000101000000Z
title: Head of Nothing
structuralObjectClass: inetOrgPerson

dn: cn=jdoe,ou=groups,dc=example,dc=com
objectClass: posixGroup
objectClass: top
cn: jdoe
gidNumber: 1500
memberUid: bsmith

dn: cn=staff,ou=groups,dc=example,dc=com
objectClass: groupOfNames
objectClass: top
cn: staff
description: All staff
member: cn=jdoe,ou=people,dc=example,dc=com
member: cn=bsmith,ou=people,dc=example,dc=com
member: cn=contractors,ou=groups,dc=example,dc=com

dn: cn=contractors,ou=groups,dc=example,dc=com
objectClass: groupOfNames
objectClass: top
cn: contractors
member: cn=ghost,ou=people,dc=example,dc=com
`;

const plan = (ldif = SAMPLE, existing = {}) => {
	const entries = parseLDIF(ldif);
	return buildPlan(entries, detectProfile(entries), existing);
};
const userNamed = (p, name) => p.users.find((u) => u.username === name);
const groupNamed = (p, name) => p.groups.find((g) => g.cn === name);

// ── Parser ──────────────────────────────────────────────────────────────────

describe('LDIF parsing', () => {
	test('splits entries on blank lines and keeps multi-valued attributes', () => {
		const entries = parseLDIF(SAMPLE);
		expect(entries).toHaveLength(6);
		const staff = entries.find((e) => e.dn === 'cn=staff,ou=groups,dc=example,dc=com');
		expect(all(staff, 'member')).toHaveLength(3);
	});

	// The single leading space is syntax, not part of the value.
	test('unfolds continuation lines', () => {
		const jdoe = parseLDIF(SAMPLE).find((e) => one(e, 'uid') === 'jdoe');
		expect(one(jdoe, 'sshPublicKey')).toBe('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEKEY jane@example.com');
	});

	test('decodes base64 values', () => {
		const jdoe = parseLDIF(SAMPLE).find((e) => one(e, 'uid') === 'jdoe');
		expect(one(jdoe, 'userPassword')).toBe('{SSHA512}abcdef');
	});

	// A value that legitimately begins with a space is why base64 exists here;
	// getting this wrong silently trims real data.
	test('preserves leading whitespace inside a base64 value', () => {
		const entries = parseLDIF('dn: cn=x\nsn:: IHNlcnZpY2U=\n');
		expect(one(entries[0], 'sn')).toBe(' service');
	});

	test('attribute lookup is case-insensitive', () => {
		const jdoe = parseLDIF(SAMPLE).find((e) => one(e, 'UID') === 'jdoe');
		expect(one(jdoe, 'GIVENNAME')).toBe('Jane');
		expect(one(jdoe, 'givenname')).toBe('Jane');
	});

	test('ignores comments and the version header', () => {
		const entries = parseLDIF('version: 1\n# a comment\ndn: cn=x\ncn: x\n');
		expect(entries).toHaveLength(1);
		expect(one(entries[0], 'cn')).toBe('x');
	});

	// Attribute options qualify the encoding, not the identity of the attribute.
	test('strips attribute options', () => {
		const entries = parseLDIF('dn: cn=x\nuserCertificate;binary: AAAA\n');
		expect(one(entries[0], 'userCertificate')).toBe('AAAA');
	});

	// Reading a file path named in an uploaded dump would be a file-disclosure
	// primitive handed to whoever supplies the file.
	test('refuses URL-referenced values', () => {
		expect(() => parseLDIF('dn: cn=x\njpegPhoto:< file:///etc/passwd\n')).toThrow(/URL reference/);
	});

	test('rejects change records rather than misreading them as content', () => {
		expect(() => parseLDIF('dn: cn=x\nchangetype: modify\nreplace: cn\n')).toThrow(/change record/);
	});

	test('rejects corrupt base64 instead of silently dropping characters', () => {
		expect(() => parseLDIF('dn: cn=x\nsn:: not*valid*base64\n')).toThrow(/invalid base64/);
	});

	test('handles CRLF line endings', () => {
		const entries = parseLDIF('dn: cn=x\r\ncn: x\r\n\r\ndn: cn=y\r\ncn: y\r\n');
		expect(entries).toHaveLength(2);
	});

	test('empty input is not an error', () => {
		expect(parseLDIF('')).toEqual([]);
		expect(parseLDIF(null)).toEqual([]);
	});

	// A comma inside an escaped RDN must not be mistaken for the separator.
	test('parentDN respects escaped commas', () => {
		expect(parentDN('cn=Doe\\, Jane,ou=people,dc=example,dc=com')).toBe('ou=people,dc=example,dc=com');
		expect(parentDN('dc=com')).toBe('');
	});
});

// ── Profiling ───────────────────────────────────────────────────────────────

describe('source profile detection', () => {
	test('prefers the objectClass that carries uidNumber', () => {
		// inetOrgPerson appears just as often, but an account without uidNumber
		// cannot satisfy the id-preservation guarantee.
		expect(detectProfile(parseLDIF(SAMPLE)).userObjectClass).toBe('posixaccount');
	});

	test('picks a username attribute that is unique across accounts', () => {
		// cn is present on both accounts but is a display name on one of them,
		// so uid is the only attribute that identifies them.
		expect(detectProfile(parseLDIF(SAMPLE)).usernameAttr).toBe('uid');
	});

	test('falls back to cn when there is no uid', () => {
		const ldif = 'dn: cn=alice,ou=people,dc=e,dc=c\nobjectClass: posixAccount\ncn: alice\nuidNumber: 1\ngidNumber: 1\n';
		expect(detectProfile(parseLDIF(ldif)).usernameAttr).toBe('cn');
	});

	test('detects the membership attribute actually in use', () => {
		expect(detectProfile(parseLDIF(SAMPLE)).memberAttr).toBe('member');
	});

	test('offers only the classes present in the file as overrides', () => {
		const available = detectProfile(parseLDIF(SAMPLE)).available.objectClasses.map((o) => o.name);
		expect(available).toContain('posixaccount');
		expect(available).toContain('groupofnames');
		expect(available).not.toContain('user');
	});
});

// ── Planning ────────────────────────────────────────────────────────────────

describe('plan building', () => {
	test('preserves uidNumber and gidNumber verbatim', () => {
		const jane = userNamed(plan(), 'jdoe');
		expect(jane.uidNumber).toBe('1500');
		expect(jane.gidNumber).toBe('1500');
	});

	test('carries standard attributes across', () => {
		const jane = userNamed(plan(), 'jdoe');
		expect(jane).toMatchObject({
			sn: 'Doe', givenName: 'Jane', mail: 'jane@example.com',
			mobile: '+15550100', loginShell: '/bin/bash', homeDirectory: '/home/jdoe',
		});
		expect(jane.sshPublicKey).toHaveLength(1);
	});

	test('reports the password scheme without exposing the hash to callers of redactPlan', () => {
		const p = plan();
		expect(userNamed(p, 'jdoe').passwordScheme).toBe('SSHA512');
		expect(userNamed(p, 'jdoe').userPassword).toBe('{SSHA512}abcdef');

		const redacted = redactPlan(p);
		expect(redacted.users.every((u) => !('userPassword' in u))).toBe(true);
		// The scheme still has to survive redaction -- the review UI shows it.
		expect(redacted.users.find((u) => u.username === 'jdoe').passwordScheme).toBe('SSHA512');
	});

	test('flags legacy MD5 passwords', () => {
		expect(userNamed(plan(), 'bsmith').warnings.join(' ')).toMatch(/MD5/);
	});

	test('carries the disabled state of a locked account', () => {
		expect(userNamed(plan(), 'bsmith').locked).toBe(true);
		expect(userNamed(plan(), 'jdoe').locked).toBe(false);
	});

	// The source cn is a display name here; keeping it would produce a DN this
	// app's personal-group handling cannot derive.
	test('warns that a mismatched cn will be normalized', () => {
		expect(userNamed(plan(), 'bsmith').warnings.join(' ')).toMatch(/cn "Bob Smith" will be normalized/);
	});

	test('reports attributes it will not migrate', () => {
		expect(userNamed(plan(), 'bsmith').warnings.join(' ')).toMatch(/not migrated: title/);
	});

	// Operational attributes are noise in every dump; naming them as unmigrated
	// would bury the warnings that matter.
	test('says nothing about operational attributes', () => {
		const warnings = plan().users.flatMap((u) => u.warnings).join(' ');
		expect(warnings).not.toMatch(/entryUUID|structuralObjectClass|memberOf|createTimestamp/);
	});

	test('an entry with no uidNumber is blocked, not renumbered', () => {
		const ldif = 'dn: cn=x,ou=people,dc=e,dc=c\nobjectClass: posixAccount\ncn: x\nuid: x\ngidNumber: 5\n';
		expect(plan(ldif).users[0].blocking.join(' ')).toMatch(/no uidNumber/);
	});

	test('blocks a username that already exists in the target', () => {
		const p = plan(SAMPLE, { usernames: ['jdoe'] });
		expect(userNamed(p, 'jdoe').blocking.join(' ')).toMatch(/already exists/);
		expect(userNamed(p, 'jdoe').decision).toBe('reject');
		expect(userNamed(p, 'bsmith').blocking).toHaveLength(0);
	});

	test('blocks a uidNumber that is already in use in the target', () => {
		const p = plan(SAMPLE, { uidNumbers: ['1500'] });
		expect(userNamed(p, 'jdoe').blocking.join(' ')).toMatch(/uidNumber 1500 is already in use/);
	});

	test('blocks duplicates inside the file itself', () => {
		const dup = SAMPLE + `
dn: cn=jdoe2,ou=people,dc=example,dc=com
objectClass: posixAccount
cn: jdoe2
uid: jdoe
uidNumber: 1600
gidNumber: 1600
`;
		// Pinned to uid, as the operator would on the mapping step: detection
		// would otherwise notice uid is no longer unique and fall to cn (see
		// the test below), which is a different scenario than the one under test.
		const entries = parseLDIF(dup);
		const p = buildPlan(entries, { ...detectProfile(entries), usernameAttr: 'uid' }, {});

		// First occurrence survives, the second is blocked -- merging two
		// accounts silently would be worse than making someone choose.
		expect(p.users.filter((u) => u.username === 'jdoe')[0].blocking).toHaveLength(0);
		expect(p.users.filter((u) => u.username === 'jdoe')[1].blocking.join(' ')).toMatch(/duplicate username/);
	});

	// Detection skips a candidate that is not unique, because a username that
	// identifies two accounts identifies neither. The operator can still pin it
	// on the mapping step, and then sees the duplicates as blocked rows.
	test('a non-unique attribute is not chosen as the username', () => {
		const dup = SAMPLE + `
dn: cn=jdoe2,ou=people,dc=example,dc=com
objectClass: posixAccount
cn: jdoe2
uid: jdoe
uidNumber: 1600
gidNumber: 1600
`;
		expect(detectProfile(parseLDIF(dup)).usernameAttr).not.toBe('uid');
	});

	test('a personal posixGroup is attached to its user, not offered for mapping', () => {
		const p = plan();
		expect(groupNamed(p, 'jdoe')).toBeUndefined();
		expect(p.personalGroups.map((g) => g.cn)).toContain('jdoe');
		expect(p.stats.personalGroups).toBe(1);
	});

	test('resolves group members from DNs to usernames', () => {
		expect(groupNamed(plan(), 'staff').memberUsernames.sort()).toEqual(['bsmith', 'jdoe']);
	});

	test('nested group members are reported rather than migrated', () => {
		const staff = groupNamed(plan(), 'staff');
		expect(staff.nestedGroups).toEqual(['cn=contractors,ou=groups,dc=example,dc=com']);
		expect(staff.warnings.join(' ')).toMatch(/nested group member/);
	});

	test('members not present in the file are reported', () => {
		expect(groupNamed(plan(), 'contractors').warnings.join(' ')).toMatch(/1 member\(s\) not found/);
	});

	// Groups are never created by an import, so the default has to be "drop".
	test('groups default to no target', () => {
		expect(plan().groups.every((g) => g.target === '')).toBe(true);
	});

	test('non-user, non-group entries are counted as skipped', () => {
		expect(plan().skipped.map((s) => s.dn)).toContain('dc=example,dc=com');
	});

	test('memberUid groups resolve bare usernames', () => {
		const ldif = `dn: cn=alice,ou=people,dc=e,dc=c
objectClass: posixAccount
uid: alice
uidNumber: 1000
gidNumber: 1000

dn: cn=wheel,ou=groups,dc=e,dc=c
objectClass: posixGroup
cn: wheel
gidNumber: 10
memberUid: alice
memberUid: nobody
`;
		const entries = parseLDIF(ldif);
		const profile = { ...detectProfile(entries), memberAttr: 'memberuid' };
		const p = buildPlan(entries, profile, {});
		const wheel = p.groups.find((g) => g.cn === 'wheel');
		expect(wheel.memberUsernames).toEqual(['alice']);
		expect(wheel.unresolved).toEqual(['nobody']);
	});

	// Real dumps contain `sshPublicKey:` with no value. Counting that as a key
	// makes the review screen promise something the server drops on write.
	test('an attribute present but empty is not counted as a value', () => {
		const ldif = `dn: cn=e,ou=people,dc=e,dc=c
objectClass: posixAccount
uid: e
uidNumber: 1000
gidNumber: 1000
sshPublicKey:
mobile:${' '}
title:
`;
		const u = plan(ldif).users[0];
		expect(u.sshPublicKey).toEqual([]);
		expect(u.mobile).toBe('');
		// ...and it is not reported as something being left behind either.
		expect(u.warnings.join(' ')).not.toMatch(/not migrated/);
	});

	test('passwordScheme reads the stored prefix', () => {
		expect(passwordScheme('{SSHA}abc')).toBe('SSHA');
		expect(passwordScheme('{crypt}abc')).toBe('CRYPT');
		expect(passwordScheme('literal')).toBe('PLAINTEXT');
		expect(passwordScheme('')).toBe('');
	});
});

// ── Applying ────────────────────────────────────────────────────────────────

function mockDeps() {
	const added = [];
	const groupAdds = [];
	const verifications = new Map();
	const setActive = [];

	const User = {
		add: jest.fn(async (data, options) => {
			added.push({ data, options });
			const created = { uid: data.uid, dn: `cn=${data.uid},ou=people,dc=t,dc=c`, setActive: jest.fn(async (a) => { setActive.push([data.uid, a]); }) };
			return created;
		}),
		addPersonalGroupMember: jest.fn(async () => {}),
	};
	const Group = {
		get: jest.fn(async (cn) => ({ cn, addMember: jest.fn(async (user) => { groupAdds.push([cn, user.uid]); }) })),
	};
	const UserVerification = {
		getOrCreate: jest.fn(async (uid) => {
			const row = { uid, update: jest.fn(async (u) => { verifications.set(uid, u); }) };
			return row;
		}),
	};
	return { User, Group, UserVerification, added, groupAdds, verifications, setActive };
}

describe('applying a plan', () => {
	test('creates accounts with id and hash preservation switched on', async () => {
		const deps = mockDeps();
		const p = plan();
		await applyPlan(p, {}, deps);

		const jane = deps.added.find((a) => a.data.uid === 'jdoe');
		expect(jane.options).toMatchObject({ preserveIds: true, preserveHash: true, suppressWelcome: true });
		expect(jane.data.uidNumber).toBe('1500');
		expect(jane.data.gidNumber).toBe('1500');
		expect(jane.data.userPassword).toBe('{SSHA512}abcdef');
	});

	// A migration that emails 32 people "welcome to your new account" is a
	// support incident, not a feature.
	test('never sends a welcome email', async () => {
		const deps = mockDeps();
		await applyPlan(plan(), {}, deps);
		expect(deps.added.every((a) => a.options.suppressWelcome)).toBe(true);
	});

	test('rejected users are skipped and never created', async () => {
		const deps = mockDeps();
		const p = plan();
		userNamed(p, 'bsmith').decision = 'reject';
		const report = await applyPlan(p, {}, deps);

		expect(deps.added.map((a) => a.data.uid)).toEqual(['jdoe']);
		expect(report.users.find((u) => u.username === 'bsmith').status).toBe('skipped');
	});

	test('blocked users are skipped even if the decision says otherwise', async () => {
		const deps = mockDeps();
		const p = plan(SAMPLE, { usernames: ['jdoe'] });
		userNamed(p, 'jdoe').decision = 'import'; // as a hostile client might send
		await applyPlan(p, {}, deps);
		expect(deps.added.map((a) => a.data.uid)).not.toContain('jdoe');
	});

	test('service accounts join app_sso_service_account', async () => {
		const deps = mockDeps();
		const p = plan();
		userNamed(p, 'jdoe').decision = 'service';
		await applyPlan(p, {}, deps);
		expect(deps.groupAdds).toContainEqual(['app_sso_service_account', 'jdoe']);
	});

	test('a locked source account is imported disabled', async () => {
		const deps = mockDeps();
		await applyPlan(plan(), {}, deps);
		expect(deps.setActive).toContainEqual(['bsmith', false]);
		expect(deps.setActive.map((s) => s[0])).not.toContain('jdoe');
	});

	test('onboarding flags are only set when the operator asks', async () => {
		const off = mockDeps();
		await applyPlan(plan(), {}, off);
		expect(off.verifications.size).toBe(0);

		const on = mockDeps();
		await applyPlan(plan(), { acceptTos: true, verifyEmail: true }, on);
		expect(on.verifications.get('jdoe')).toMatchObject({ tos_accepted: true, email_verified: true });
		// bsmith has no mail, so there is nothing to mark verified.
		expect(on.verifications.get('bsmith')).toMatchObject({ tos_accepted: true });
		expect(on.verifications.get('bsmith').email_verified).toBeUndefined();
	});

	test('group membership is written only for mapped groups', async () => {
		const deps = mockDeps();
		const p = plan();
		groupNamed(p, 'staff').target = 'app_thing_access';
		const report = await applyPlan(p, {}, deps);

		expect(deps.groupAdds).toContainEqual(['app_thing_access', 'jdoe']);
		expect(deps.groupAdds).toContainEqual(['app_thing_access', 'bsmith']);
		expect(report.groups.find((g) => g.cn === 'contractors').status).toBe('skipped');
	});

	// Answering the question "what happens to a group whose members were
	// rejected" -- the reference is dropped, the group is not left dangling.
	test('members of a mapped group who were rejected are not added', async () => {
		const deps = mockDeps();
		const p = plan();
		userNamed(p, 'bsmith').decision = 'reject';
		groupNamed(p, 'staff').target = 'app_thing_access';
		await applyPlan(p, {}, deps);

		expect(deps.groupAdds).toContainEqual(['app_thing_access', 'jdoe']);
		expect(deps.groupAdds).not.toContainEqual(['app_thing_access', 'bsmith']);
	});

	test('several source groups can merge into one target', async () => {
		const deps = mockDeps();
		const p = plan();
		groupNamed(p, 'staff').target = 'app_thing_access';
		groupNamed(p, 'contractors').target = 'app_thing_access';
		const report = await applyPlan(p, {}, deps);
		expect(report.groups.filter((g) => g.target === 'app_thing_access')).toHaveLength(2);
	});

	// Import is resumable, not transactional: one failure must not abandon the
	// other 200 accounts.
	test('a failure on one account does not stop the rest', async () => {
		const deps = mockDeps();
		deps.User.add.mockImplementationOnce(async () => { throw new Error('LDAP said no'); });
		const report = await applyPlan(plan(), {}, deps);

		expect(report.users.find((u) => u.username === 'jdoe')).toMatchObject({ status: 'failed', detail: 'LDAP said no' });
		expect(report.users.find((u) => u.username === 'bsmith').status).toBe('imported');
		expect(report.summary).toMatchObject({ imported: 1, failed: 1 });
	});

	test('supplementary members of a personal group are restored', async () => {
		const deps = mockDeps();
		await applyPlan(plan(), {}, deps);
		// jdoe's personal group listed bsmith as a supplementary member.
		expect(deps.User.addPersonalGroupMember).toHaveBeenCalledWith('jdoe', 'bsmith');
	});
});
