'use strict';

// Admin-only LDIF migration API. See docs/ldif-import.md for the procedure and
// utils/ldif_import.js for why the import goes through the model layer.
//
// Staging lives in Redis, not the database, and that is a security decision
// rather than a convenience one. A parsed dump contains every password hash in
// the source directory; putting it in sqlite would place those hashes in the
// file that gets backed up, copied to laptops, and kept forever. Redis holds
// the staged plan under a short TTL and it is deleted the moment the import is
// applied or abandoned. (If your Redis is configured with AOF/RDB persistence
// the hashes can still touch disk transiently -- documented, not hidden.)
//
// Password hashes are never included in any response; redactPlan strips them
// on the way out and the review UI only ever sees the scheme name.

const router = require('express').Router();
const express = require('express');
const crypto = require('crypto');
const { createClient } = require('redis');
const conf = require('@simpleworkjs/conf');

const permission = require('../utils/permission');
const { parseLDIF } = require('../utils/ldif');
const { detectProfile, buildPlan, redactPlan, applyPlan } = require('../utils/ldif_import');
const { User } = require('../models/user_ldap');
const { Group } = require('../models/group_ldap');
const { UserVerification } = require('../models/verification');

const STAGE_TTL_SECONDS = 60 * 60;
const MAX_UPLOAD = '64mb';
const ADMIN_GROUPS = [permission.SUPER_ADMIN_GROUP, 'app_sso_admin'];

let redisClient;
async function getRedis() {
	if (!redisClient) {
		const url = (conf.redis && typeof conf.redis === 'string') ? conf.redis
			: (conf.redis && conf.redis.url) ? conf.redis.url : undefined;
		redisClient = createClient({ url });
		redisClient.on('error', (err) => console.error('Redis ldif_import error', err));
		await redisClient.connect();
	}
	return redisClient;
}

const prefix = (conf.redis && conf.redis.prefix) || 'sso_manager_';
const stageKey = (id) => `${prefix}ldif_import:${id}`;

async function readStage(id) {
	const raw = await (await getRedis()).get(stageKey(id));
	if (!raw) {
		throw Object.assign(new Error('This import has expired or was already applied. Upload the file again.'), { status: 404 });
	}
	return JSON.parse(raw);
}

async function writeStage(id, stage) {
	await (await getRedis()).set(stageKey(id), JSON.stringify(stage), { EX: STAGE_TTL_SECONDS });
}

async function destroyStage(id) {
	await (await getRedis()).del(stageKey(id)).catch(() => {});
}

// Every route here can set arbitrary passwords on arbitrary usernames, so the
// gate is the same one that guards directory administration -- not merely
// "logged in".
async function requireAdmin(req, res, next) {
	try {
		await permission.byGroup(req.user, ADMIN_GROUPS);
		next();
	} catch (error) {
		next(error);
	}
}
router.use(requireAdmin);

// What the target directory already has, so the plan can flag collisions before
// anything is written. This is a preview: addPosixGroup/addPosixAccount re-check
// authoritatively at write time, because the directory can change between
// review and apply.
async function existingSnapshot() {
	const users = await User.listDetail().catch(() => []);
	return {
		usernames: users.map((u) => u.uid).filter(Boolean),
		uidNumbers: users.map((u) => u.uidNumber).filter(Boolean),
		gidNumbers: users.map((u) => u.gidNumber).filter(Boolean),
		count: users.length,
	};
}

// The dropdown on the group-mapping page. Groups are never created by an
// import, so this is the complete set of things a source group can become.
router.get('/targets', async function(req, res, next) {
	try {
		const groups = await Group.listDetail();
		res.json({
			results: groups
				.map((g) => ({ cn: g.cn, description: g.description || '', members: [].concat(g.member || []).filter(Boolean).length }))
				.sort((a, b) => a.cn.localeCompare(b.cn)),
		});
	} catch (error) { next(error); }
});

// Readiness: the documented procedure is to import into a directory that has no
// users yet. This does not block the import -- an operator who knows what they
// are doing may have a reason -- but the UI shows it prominently, because
// importing on top of an existing population is how you get collisions on every
// row and a half-migrated directory.
router.get('/readiness', async function(req, res, next) {
	try {
		const [snapshot, groups] = await Promise.all([existingSnapshot(), Group.listDetail().catch(() => [])]);
		const others = snapshot.usernames.filter((uid) => uid !== req.user.uid);
		res.json({
			userCount: snapshot.count,
			otherUsers: others,
			groupCount: groups.length,
			clean: others.length === 0,
		});
	} catch (error) { next(error); }
});

// The dump arrives as a text body rather than multipart so no upload middleware
// is needed; Express 5 ships express.text().
router.post('/upload', express.text({ type: '*/*', limit: MAX_UPLOAD }), async function(req, res, next) {
	try {
		const text = typeof req.body === 'string' ? req.body : '';
		if (!text.trim()) {
			throw Object.assign(new Error('No LDIF content received.'), { status: 400 });
		}

		const entries = parseLDIF(text);
		if (!entries.length) {
			throw Object.assign(new Error('No entries found. Is this an LDIF export?'), { status: 400 });
		}

		const profile = detectProfile(entries);
		if (!profile.userObjectClass) {
			throw Object.assign(
				new Error('Could not find any user entries in this file. Check that the export includes the people subtree.'),
				{ status: 400 }
			);
		}

		const existing = await existingSnapshot();
		const plan = buildPlan(entries, profile, existing);
		const id = crypto.randomUUID();

		await writeStage(id, { id, createdAt: Date.now(), createdBy: req.user.uid, entries, profile, plan });

		res.json({ importId: id, profile, plan: redactPlan(plan), existing: { userCount: existing.count } });
	} catch (error) { next(error); }
});

router.get('/:id', async function(req, res, next) {
	try {
		const stage = await readStage(req.params.id);
		res.json({ importId: stage.id, profile: stage.profile, plan: redactPlan(stage.plan) });
	} catch (error) { next(error); }
});

// Re-plan under an operator-corrected schema mapping. The parsed entries are
// still staged, so this is a recompute rather than a re-upload.
router.put('/:id/mapping', async function(req, res, next) {
	try {
		const stage = await readStage(req.params.id);
		const profile = {
			...stage.profile,
			userObjectClass: req.body.userObjectClass || stage.profile.userObjectClass,
			usernameAttr: req.body.usernameAttr || stage.profile.usernameAttr,
			memberAttr: req.body.memberAttr || stage.profile.memberAttr,
			groupObjectClasses: Array.isArray(req.body.groupObjectClasses) && req.body.groupObjectClasses.length
				? req.body.groupObjectClasses
				: stage.profile.groupObjectClasses,
		};
		const plan = buildPlan(stage.entries, profile, await existingSnapshot());
		await writeStage(stage.id, { ...stage, profile, plan });
		res.json({ importId: stage.id, profile, plan: redactPlan(plan) });
	} catch (error) { next(error); }
});

// Per-user decisions: import / service / reject, keyed by username.
router.put('/:id/users', async function(req, res, next) {
	try {
		const stage = await readStage(req.params.id);
		const decisions = req.body.decisions || {};
		const allowed = new Set(['import', 'service', 'reject']);

		for (const user of stage.plan.users) {
			const choice = decisions[user.username];
			if (choice === undefined) continue;
			if (!allowed.has(choice)) {
				throw Object.assign(new Error(`Unknown decision "${choice}" for ${user.username}`), { status: 400 });
			}
			// A blocked row cannot be imported no matter what the client sends --
			// the blocking reasons are things like a uidNumber already in use,
			// which the apply step would fail on anyway, later and messier.
			user.decision = (user.blocking.length && choice !== 'reject') ? 'reject' : choice;
		}

		await writeStage(stage.id, stage);
		res.json({ ok: true, plan: redactPlan(stage.plan) });
	} catch (error) { next(error); }
});

// Group mapping: source group -> existing target group cn, or '' to drop it.
router.put('/:id/groups', async function(req, res, next) {
	try {
		const stage = await readStage(req.params.id);
		const mapping = req.body.mapping || {};
		const existing = new Set((await Group.listDetail()).map((g) => g.cn));

		for (const group of stage.plan.groups) {
			const target = mapping[group.sourceDn];
			if (target === undefined) continue;
			if (target && !existing.has(target)) {
				throw Object.assign(new Error(`No group named "${target}" exists in this directory.`), { status: 400 });
			}
			group.target = target || '';
		}

		await writeStage(stage.id, stage);
		res.json({ ok: true, plan: redactPlan(stage.plan) });
	} catch (error) { next(error); }
});

router.post('/:id/apply', async function(req, res, next) {
	try {
		const stage = await readStage(req.params.id);
		const options = {
			verifyEmail: req.body.verifyEmail === true || req.body.verifyEmail === 'true',
			acceptTos: req.body.acceptTos === true || req.body.acceptTos === 'true',
		};

		const report = await applyPlan(stage.plan, options, { User, Group, UserVerification });

		// The staged plan and every hash in it stop existing the moment the
		// import is done, successfully or not. A partial run is re-driven by
		// uploading the file again -- the accounts that made it are then simply
		// reported as already existing.
		await destroyStage(stage.id);
		User.clearCache();

		console.log(`[ldif-import] ${req.user.uid} imported ${report.summary.imported} user(s), ` +
			`${report.summary.failed} failed, ${report.summary.skipped} skipped`);

		res.json({ report });
	} catch (error) { next(error); }
});

router.delete('/:id', async function(req, res, next) {
	try {
		await destroyStage(req.params.id);
		res.json({ ok: true });
	} catch (error) { next(error); }
});

module.exports = router;
