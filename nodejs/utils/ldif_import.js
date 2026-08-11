'use strict';

// Migrating an existing LDAP directory into this one, through the app's own
// model layer rather than by writing entries to slapd directly.
//
// Why not just `ldapadd` the dump? Because an entry written behind the app is
// an entry the app never saw: no UserVerification row, no personal-group
// invariant, no service-account membership, no cache invalidation, and no
// chance for the group model (docs/GROUPS.md) to have an opinion. The whole
// point of a migration is to arrive in a state the app considers normal.
//
// Two properties are non-negotiable and drive most of what follows:
//
//   * uidNumber/gidNumber are preserved exactly. They are what every file on
//     every host is owned by; reallocating them turns a migration into a
//     filesystem-wide chown nobody asked for.
//   * userPassword is carried across as the stored hash, never re-hashed.
//     Re-hashing an already-hashed value produces an account whose password is
//     the literal string "{MD5}...", which nobody can ever log in as.
//
// Both require model-layer cooperation that ordinary user creation must NOT
// have -- see the `preserveIds`/`preserveHash` options in models/user_ldap.js
// and the note there about why they are a separate argument rather than fields
// on the request body.
//
// This file is schema-agnostic by design. `detectProfile` guesses how the
// source directory is laid out and the operator can override every guess, so
// pointing it at a FreeIPA or AD export is a mapping change, not a code change.

const { parseLDIF, one, all, objectClasses } = require('./ldif');

// Server-generated. Present in every slapcat dump, rejected by slapd on write,
// and meaningless in a new directory -- dropped without comment because
// reporting 235 "unmapped entryCSN" warnings helps nobody.
//
// memberOf deserves its own mention: it is produced by the memberof overlay
// from `member`, so it is not input at all. Group membership is migrated from
// the group side, via the mapping the operator chooses.
const OPERATIONAL = new Set([
	'structuralobjectclass', 'entryuuid', 'creatorsname', 'createtimestamp',
	'entrycsn', 'modifiersname', 'modifytimestamp', 'entrydn', 'subschemasubentry',
	'hassubordinates', 'numsubordinates', 'contextcsn', 'memberof',
	'pwdchangedtime', 'pwdhistory', 'pwdfailuretime', 'pwdgraceusetime',
	'objectclass', 'dn',
]);

// Carried onto the new account. Each target field lists the source attributes
// to try in order, so a directory that stores a phone in telephoneNumber lands
// in the same place as one using mobile.
const USER_FIELDS = {
	sn:            ['sn'],
	givenName:     ['givenname'],
	mail:          ['mail'],
	mobile:        ['mobile', 'telephonenumber'],
	loginShell:    ['loginshell'],
	homeDirectory: ['homedirectory'],
	description:   ['description'],
	location:      ['l'],
	dateOfBirth:   ['dateofbirth'],
};

// Consumed structurally rather than copied verbatim, so they are not "unmapped"
// even though they never appear in USER_FIELDS.
const USER_STRUCTURAL = new Set([
	'uid', 'cn', 'uidnumber', 'gidnumber', 'userpassword', 'sshpublickey',
	'pwdaccountlockedtime', 'sudohost', 'sudocommand', 'sudouser', 'sudorunasuser',
	'sudooption', 'samaccountname', 'displayname',
]);

const USER_CLASS_CANDIDATES  = ['posixaccount', 'inetorgperson', 'organizationalperson', 'person', 'user'];
const USERNAME_ATTR_CANDIDATES = ['uid', 'samaccountname', 'cn'];
const GROUP_CLASS_CANDIDATES = ['groupofnames', 'groupofuniquenames', 'posixgroup', 'group'];
const MEMBER_ATTR_CANDIDATES = ['member', 'uniquemember', 'memberuid'];

const lc = (s) => String(s || '').toLowerCase();

// ── Profiling ───────────────────────────────────────────────────────────────

// Guess how the source directory is laid out. Every field is an operator-
// overridable default, not a decision -- a directory this code has never seen
// should be importable by correcting the guess in the UI.
function detectProfile(entries) {
	const classCounts = new Map();
	for (const entry of entries) {
		for (const oc of objectClasses(entry)) classCounts.set(oc, (classCounts.get(oc) || 0) + 1);
	}

	// posixAccount wins over inetOrgPerson when both are present: it is the one
	// that carries uidNumber, and an account without a uidNumber cannot satisfy
	// the preservation guarantee this importer exists for.
	const userObjectClass = USER_CLASS_CANDIDATES.find((c) => classCounts.get(c)) || '';
	const users = entries.filter((e) => objectClasses(e).has(userObjectClass));

	// The username attribute has to be present on essentially every account and
	// unique across them; `cn` is usually present but often a display name
	// ("Jane Doe"), which is why it is tried last.
	let usernameAttr = '';
	for (const candidate of USERNAME_ATTR_CANDIDATES) {
		const values = users.map((u) => one(u, candidate)).filter(Boolean);
		if (users.length && values.length === users.length && new Set(values.map(lc)).size === values.length) {
			usernameAttr = candidate;
			break;
		}
	}
	if (!usernameAttr) usernameAttr = USERNAME_ATTR_CANDIDATES.find((c) => users.some((u) => one(u, c))) || 'uid';

	const groupObjectClasses = GROUP_CLASS_CANDIDATES.filter((c) => classCounts.get(c));
	const groups = entries.filter((e) => groupObjectClasses.some((c) => objectClasses(e).has(c)));
	const memberAttr = MEMBER_ATTR_CANDIDATES.find((a) => groups.some((g) => all(g, a).length)) || 'member';

	return {
		userObjectClass,
		usernameAttr,
		groupObjectClasses,
		memberAttr,
		// Offered as dropdown options in the UI so an override is a choice
		// between things actually present in the file, not free text.
		available: {
			objectClasses: [...classCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
			usernameAttrs: USERNAME_ATTR_CANDIDATES.filter((c) => users.some((u) => one(u, c))),
			memberAttrs: MEMBER_ATTR_CANDIDATES.filter((a) => groups.some((g) => all(g, a).length)),
		},
	};
}

// ── Planning ────────────────────────────────────────────────────────────────

function passwordScheme(hash) {
	const match = String(hash || '').match(/^\{([\w-]+)\}/);
	if (!match) return hash ? 'PLAINTEXT' : '';
	return match[1].toUpperCase();
}

// Schemes slapd can verify without a contrib module loaded. An account whose
// hash the server cannot check imports cleanly and then refuses every login,
// which is worth saying out loud at review time rather than discovering later.
const VERIFIABLE_SCHEMES = new Set(['SSHA', 'SHA', 'SMD5', 'MD5', 'CRYPT', 'SSHA512', 'SSHA256', 'CLEARTEXT', 'PLAINTEXT']);

// An attribute present but empty (`sshPublicKey:` with nothing after it) is a
// real thing in real dumps. It carries no information, and counting it as a
// value makes the review screen promise data that will not arrive -- the server
// drops it on write regardless.
const values = (entry, name) => all(entry, name).map((v) => String(v).trim()).filter(Boolean);

function pick(entry, candidates) {
	for (const attr of candidates) {
		const found = values(entry, attr);
		if (found.length) return found[0];
	}
	return '';
}

function unmappedAttrs(entry) {
	return Object.keys(entry.attrs).filter((name) => {
		if (OPERATIONAL.has(name)) return false;
		if (USER_STRUCTURAL.has(name)) return false;
		// Nothing is lost by not migrating an attribute that holds nothing.
		if (!values(entry, name).length) return false;
		return !Object.values(USER_FIELDS).some((candidates) => candidates.includes(name));
	});
}

// Build the reviewable plan: what each source entry would become, what is
// missing, and what cannot be migrated. Nothing here touches LDAP -- the plan
// is derived purely from the file plus a snapshot of what already exists, so
// it can be rebuilt cheaply whenever the operator changes the mapping.
function buildPlan(entries, profile, existing = {}) {
	const existingUsernames = new Set((existing.usernames || []).map(lc));
	const existingUidNumbers = new Set((existing.uidNumbers || []).map(Number).filter(Number.isFinite));
	const existingGidNumbers = new Set((existing.gidNumbers || []).map(Number).filter(Number.isFinite));

	const isUser  = (e) => objectClasses(e).has(profile.userObjectClass);
	const isGroup = (e) => profile.groupObjectClasses.some((c) => objectClasses(e).has(c));

	const userEntries = entries.filter(isUser);
	// A posixGroup that exists only to hold one user's primary gid is part of
	// that user, not a permission to be mapped. Matched by gidNumber first
	// (authoritative) and name second, because the two disagree in real dumps.
	const primaryGids = new Set(userEntries.map((e) => one(e, 'gidNumber')).filter(Boolean));
	const usernamesInFile = new Set(userEntries.map((e) => lc(one(e, profile.usernameAttr))).filter(Boolean));

	const dnToUsername = new Map();
	for (const entry of userEntries) {
		const username = one(entry, profile.usernameAttr);
		if (username) dnToUsername.set(lc(entry.dn), username);
	}

	const seenUsernames = new Map();
	const seenUidNumbers = new Map();
	const seenGidNumbers = new Map();
	const seenMobiles = new Map();

	const users = userEntries.map((entry) => {
		const username = one(entry, profile.usernameAttr);
		const uidNumber = one(entry, 'uidNumber');
		const gidNumber = one(entry, 'gidNumber');
		const hash = one(entry, 'userPassword');
		const scheme = passwordScheme(hash);
		const warnings = [];
		const blocking = [];

		if (!username) blocking.push(`no ${profile.usernameAttr} attribute — cannot derive a username`);
		if (!/^[a-zA-Z0-9._-]+$/.test(username || '')) {
			if (username) blocking.push(`username "${username}" contains characters this directory does not accept`);
		}
		if (!uidNumber) blocking.push('no uidNumber — this importer preserves ids and cannot invent one');

		// Duplicates inside the file itself. The first occurrence is kept; the
		// rest are blocked, because silently merging two accounts is worse than
		// making someone choose.
		if (username) {
			const key = lc(username);
			if (seenUsernames.has(key)) blocking.push(`duplicate username in this file (also ${seenUsernames.get(key)})`);
			else seenUsernames.set(key, entry.dn);
		}
		if (uidNumber) {
			if (seenUidNumbers.has(uidNumber)) blocking.push(`duplicate uidNumber ${uidNumber} in this file (also ${seenUidNumbers.get(uidNumber)})`);
			else seenUidNumbers.set(uidNumber, entry.dn);
		}

		// Collisions with the target. The documented procedure is to import into
		// a directory with no users, so in practice these only fire for the
		// bootstrap admin -- which is exactly the case worth stopping on.
		if (username && existingUsernames.has(lc(username))) blocking.push(`a user named "${username}" already exists in this directory`);
		if (uidNumber && existingUidNumbers.has(Number(uidNumber))) blocking.push(`uidNumber ${uidNumber} is already in use in this directory`);
		if (gidNumber && existingGidNumbers.has(Number(gidNumber))) blocking.push(`gidNumber ${gidNumber} is already in use in this directory`);

		if (!hash) warnings.push('no password — the account cannot be logged into until one is set');
		else if (!VERIFIABLE_SCHEMES.has(scheme)) warnings.push(`password scheme {${scheme}} may not be verifiable by this server; logins could fail`);
		else if (scheme === 'MD5') warnings.push('legacy MD5 password — the user will be forced to change it at first login');
		else if (scheme === 'PLAINTEXT') warnings.push('password appears to be stored unhashed at the source');

		const cn = one(entry, 'cn');
		if (cn && username && cn !== username) {
			warnings.push(`cn "${cn}" will be normalized to "${username}" to match this directory's convention`);
		}

		const unmapped = unmappedAttrs(entry);
		if (unmapped.length) warnings.push(`not migrated: ${unmapped.join(', ')}`);

		// Two accounts sharing a primary gid is legal POSIX and does occur --
		// the second simply references the group the first brought with it
		// (models/user_ldap.js addPosixGroup) rather than getting one of its
		// own. Said out loud because it is surprising, but not a problem.
		if (gidNumber) {
			if (seenGidNumbers.has(gidNumber)) {
				warnings.push(`shares primary group ${gidNumber} with ${seenGidNumbers.get(gidNumber)} — no personal group is created for this account`);
			} else {
				seenGidNumbers.set(gidNumber, username || entry.dn);
			}
		}

		const fields = {};
		for (const [target, candidates] of Object.entries(USER_FIELDS)) fields[target] = pick(entry, candidates);

		// This directory requires phone numbers to be unique (it can be used to
		// find an account), but source directories commonly carry a placeholder
		// like 000000000 on a dozen accounts. Dropping the duplicate loses a
		// number nobody could rely on; refusing the account over it would lose
		// the account, which is far worse. Whoever keeps it is named.
		if (fields.mobile) {
			if (seenMobiles.has(fields.mobile)) {
				warnings.push(`phone number ${fields.mobile} is already used by ${seenMobiles.get(fields.mobile)} — imported without a phone number`);
				fields.mobile = '';
			} else {
				seenMobiles.set(fields.mobile, username || entry.dn);
			}
		}

		return {
			sourceDn: entry.dn,
			username,
			uidNumber,
			gidNumber,
			...fields,
			sshPublicKey: values(entry, 'sshPublicKey'),
			sudo: {
				host: values(entry, 'sudoHost'),
				command: values(entry, 'sudoCommand'),
				user: values(entry, 'sudoUser'),
			},
			locked: !!one(entry, 'pwdAccountLockedTime'),
			passwordScheme: scheme,
			hasPassword: !!hash,
			// Kept out of every API response; see redactPlan.
			userPassword: hash,
			warnings,
			blocking,
			// Default decision. A blocked row cannot be imported at all, and a
			// locked source account defaults to being brought over still locked
			// rather than quietly reactivated.
			decision: blocking.length ? 'reject' : 'import',
		};
	});

	const groups = entries.filter((e) => isGroup(e) && !isUser(e)).map((entry) => {
		const cn = one(entry, 'cn') || one(entry, 'ou');
		const gidNumber = one(entry, 'gidNumber');
		const isPersonal = !!gidNumber && primaryGids.has(gidNumber);

		// The membership attribute is resolved per entry rather than once for the
		// whole file. A real directory mixes styles -- groupOfNames permission
		// groups using `member` alongside posixGroups using `memberUid` -- and a
		// single file-wide choice silently drops whichever kind loses.
		const memberAttr = [profile.memberAttr, 'member', 'uniquemember', 'memberuid']
			.find((attr) => all(entry, attr).length) || profile.memberAttr;

		// memberUid holds bare usernames; member/uniqueMember hold DNs.
		const rawMembers = all(entry, memberAttr).filter(Boolean);
		const memberUsernames = [];
		const nestedGroups = [];
		const unresolved = [];
		for (const value of rawMembers) {
			if (memberAttr === 'memberuid') {
				if (usernamesInFile.has(lc(value))) memberUsernames.push(value);
				else unresolved.push(value);
				continue;
			}
			const username = dnToUsername.get(lc(value));
			if (username) memberUsernames.push(username);
			else if (entries.some((e) => lc(e.dn) === lc(value) && isGroup(e))) nestedGroups.push(value);
			else unresolved.push(value);
		}

		const warnings = [];
		if (nestedGroups.length) warnings.push(`${nestedGroups.length} nested group member(s) not migrated — rebuild nesting after import`);
		if (unresolved.length) warnings.push(`${unresolved.length} member(s) not found in this file`);

		return {
			sourceDn: entry.dn,
			cn,
			description: one(entry, 'description'),
			gidNumber,
			isPersonal,
			memberAttr,
			memberUsernames,
			memberCount: memberUsernames.length,
			nestedGroups,
			unresolved,
			warnings,
			// Groups are never created by the import: a source group whose name
			// does not fit this app's model is meaningless here (docs/GROUPS.md),
			// so the only choices are "put these members into an existing group"
			// or "drop it". Empty target means drop.
			target: '',
		};
	});

	const accounted = new Set([...userEntries, ...entries.filter(isGroup)].map((e) => lc(e.dn)));
	const skipped = entries.filter((e) => !accounted.has(lc(e.dn))).map((e) => ({
		dn: e.dn,
		reason: 'not a user or group under the current mapping',
	}));

	return {
		users,
		// Personal groups ride along with their user; showing them on the
		// mapping page would ask the operator to make 30 meaningless decisions.
		groups: groups.filter((g) => !g.isPersonal),
		personalGroups: groups.filter((g) => g.isPersonal),
		skipped,
		stats: {
			entries: entries.length,
			users: users.length,
			importable: users.filter((u) => !u.blocking.length).length,
			blocked: users.filter((u) => u.blocking.length).length,
			groups: groups.filter((g) => !g.isPersonal).length,
			personalGroups: groups.filter((g) => g.isPersonal).length,
			skipped: skipped.length,
		},
	};
}

// Password hashes exist in the staged plan because the apply step needs them.
// They must never reach the browser: the review UI has no use for a hash, and
// an admin session that leaks would otherwise hand over every credential in the
// source directory at once. Only the scheme name is shown.
function redactPlan(plan) {
	return {
		...plan,
		users: plan.users.map(({ userPassword, ...rest }) => rest),
	};
}

// ── Applying ────────────────────────────────────────────────────────────────

// Import is resumable, not transactional. Rolling back would mean deleting
// real accounts on a best-effort basis after a failure whose cause we do not
// understand, which is a worse failure mode than stopping and reporting. Every
// step below is written to be safe to run again over a partially-applied plan.
async function applyPlan(plan, options, deps) {
	const { User, Group, UserVerification } = deps;
	const report = { users: [], groups: [], startedAt: Date.now() };
	const importedByUsername = new Map();

	for (const user of plan.users) {
		if (user.decision === 'reject' || user.blocking.length) {
			report.users.push({ username: user.username, status: 'skipped', detail: user.blocking[0] || 'rejected by operator' });
			continue;
		}

		try {
			const data = {
				uid: user.username,
				uidNumber: user.uidNumber,
				gidNumber: user.gidNumber,
				sn: user.sn || user.username,
				givenName: user.givenName || user.username,
				loginShell: user.loginShell || undefined,
				homeDirectory: user.homeDirectory || undefined,
				description: user.description || undefined,
				location: user.location || undefined,
				dob: user.dateOfBirth || undefined,
			};
			if (user.mail) data.mail = user.mail;
			if (user.mobile) data.mobile = user.mobile;
			if (user.sshPublicKey.length) data.sshPublicKey = user.sshPublicKey;
			if (user.userPassword) data.userPassword = user.userPassword;
			if (user.sudo.host.length) data.sudoHost = user.sudo.host;
			if (user.sudo.command.length) data.sudoCommand = user.sudo.command;
			if (user.sudo.user.length) data.sudoUser = user.sudo.user;

			const created = await User.add(data, {
				preserveIds: true,
				preserveHash: true,
				suppressWelcome: true,
			});
			importedByUsername.set(lc(user.username), created);

			if (user.decision === 'service') {
				const svc = await Group.get('app_sso_service_account');
				await svc.addMember(created).catch((e) => {
					if (e.name !== 'TypeOrValueExistsError') throw e;
				});
			}

			// Onboarding state is a per-run choice (see the import options): a
			// cutover where ToS and email were already collected elsewhere should
			// not make 32 people re-accept on day one. The MD5 password-change
			// flag is NOT part of this -- it is set from the hash itself in
			// User.get/listDetail and stays forced regardless.
			const verification = await UserVerification.getOrCreate(user.username);
			const updates = {};
			if (options.verifyEmail && user.mail) updates.email_verified = true;
			if (options.acceptTos) { updates.tos_accepted = true; updates.tos_accepted_at = Date.now(); }
			if (Object.keys(updates).length) await verification.update(updates);

			if (user.locked) await created.setActive(false);

			report.users.push({
				username: user.username,
				status: 'imported',
				detail: [
					`uid ${user.uidNumber}`,
					`gid ${user.gidNumber}`,
					user.passwordScheme ? `password {${user.passwordScheme}}` : 'no password',
					user.locked ? 'disabled' : null,
					user.decision === 'service' ? 'service account' : null,
				].filter(Boolean).join(', '),
			});
		} catch (error) {
			report.users.push({ username: user.username, status: 'failed', detail: error.message });
		}
	}

	// Groups second: membership is written from the group side, so every member
	// has to exist first. Many source groups may target one existing group --
	// that is the normal case when collapsing a sprawling old directory.
	for (const group of plan.groups) {
		if (!group.target) {
			report.groups.push({ cn: group.cn, target: '', status: 'skipped', detail: 'no target group chosen' });
			continue;
		}
		let added = 0;
		const failures = [];
		try {
			const target = await Group.get(group.target);
			for (const username of group.memberUsernames) {
				const user = importedByUsername.get(lc(username));
				// A member whose account was rejected simply does not come across.
				if (!user) continue;
				try {
					await target.addMember(user);
					added++;
				} catch (error) {
					if (error.name === 'TypeOrValueExistsError' || error.code === 20) added++;
					else failures.push(`${username}: ${error.message}`);
				}
			}
			report.groups.push({
				cn: group.cn,
				target: group.target,
				status: failures.length ? 'partial' : 'imported',
				detail: `${added} member(s) added` + (failures.length ? `; ${failures.length} failed` : ''),
			});
		} catch (error) {
			report.groups.push({ cn: group.cn, target: group.target, status: 'failed', detail: error.message });
		}
	}

	// Personal-group supplementary members (posixGroup memberUid) last: they
	// reference accounts by name and are only meaningful once both exist.
	for (const group of plan.personalGroups || []) {
		const owner = importedByUsername.get(lc(group.cn));
		if (!owner) continue;
		for (const username of group.memberUsernames) {
			if (lc(username) === lc(group.cn)) continue;
			if (!importedByUsername.has(lc(username))) continue;
			await User.addPersonalGroupMember(group.cn, username).catch(() => { /* best effort */ });
		}
	}

	report.finishedAt = Date.now();
	report.summary = {
		imported: report.users.filter((u) => u.status === 'imported').length,
		failed: report.users.filter((u) => u.status === 'failed').length,
		skipped: report.users.filter((u) => u.status === 'skipped').length,
		groupsMapped: report.groups.filter((g) => g.status === 'imported' || g.status === 'partial').length,
	};
	return report;
}

module.exports = { detectProfile, buildPlan, redactPlan, applyPlan, passwordScheme, USER_FIELDS };
