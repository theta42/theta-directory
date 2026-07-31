'use strict';

const router = require('express').Router();
const {User} = require('../models/user_ldap');
const {Group} = require('../models/group_ldap');
const permission = require('../utils/permission'); 

router.get('/', async function(req, res, next){
	try{
		let member = req.query.member ? await User.get(req.query.member) : {}

		return res.json({
			results:  await Group[req.query.detail ? "listDetail" : "list"](member.dn)
		});
	}catch(error){
		next(error);
	}
});

router.post('/', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin']);

		req.body.owner = req.user.dn;
		return res.json({
			results: await Group.add(req.body),
			message: `${req.body.name} was added!`
		})
	}catch(error){
		next(error);
	}
});


router.get('/:name', async function(req, res, next){
	try{
		return res.json({
			results:  await Group.get(req.params.name)
		});
	}catch(error){
		next(error);
	}
});

// ── Nested groups ───────────────────────────────────────────────────────────
// A groupOfNames `member` may be any DN, including another group's, which is
// how nesting is stored. These routes are mounted before /:group/:uid so the
// literal "nested"/"effective" path segments are not swallowed by that
// wildcard, which would otherwise try to resolve them as a uid.

// GET /api/group/:group/effective — who this group actually grants, split into
// directly-listed users, the groups nested into it, and the full transitive set
// of users. The UI shows "3 direct, 12 effective"; a plain member read cannot
// answer that, and on a server with nestgroup it silently returns the expanded
// list with no indication which entries are direct.
router.get('/:group/effective', async function(req, res, next){
	try{
		return res.json({ results: await Group.effectiveMembers(req.params.group) });
	}catch(error){
		next(error);
	}
});

// PUT /api/group/:group/nested/:child — nest :child inside :group.
router.put('/:group/nested/:child', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		const parent = await Group.get(req.params.group);
		const child  = await Group.get(req.params.child);

		if(parent.dn === child.dn){
			return res.status(400).json({message: 'A group cannot contain itself.'});
		}
		// Refuse rather than rely on the resolver's depth cap: a cycle makes
		// "who is in this group" unanswerable, and the cap would quietly return
		// a truncated answer instead of an error anyone would notice.
		if(await Group.wouldCycle(req.params.group, child.dn)){
			return res.status(409).json({
				message: `"${req.params.child}" already contains "${req.params.group}" — nesting them would create a loop.`
			});
		}

		const results = await parent.addMember({dn: child.dn});
		User.clearCache();
		return res.json({
			results,
			message: `Nested ${req.params.child} inside ${req.params.group}.`
		});
	}catch(error){
		if(error.name === 'TypeOrValueExistsError' || error.code === 20){
			return res.status(409).json({message: `"${req.params.child}" is already nested in "${req.params.group}".`});
		}
		next(error);
	}
});

// DELETE /api/group/:group/nested/:child — un-nest.
router.delete('/:group/nested/:child', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		const parent = await Group.get(req.params.group);
		const child  = await Group.get(req.params.child);
		const results = await parent.removeMember({dn: child.dn});
		User.clearCache();
		return res.json({
			results,
			message: `Removed ${req.params.child} from ${req.params.group}.`
		});
	}catch(error){
		// groupOfNames requires at least one member, so emptying a group is a
		// schema violation rather than a permission problem. Surfacing the raw
		// error as a 500 makes it look like a bug in the server; it is really a
		// "you cannot do that, and here is why" -- the same reason the last user
		// cannot be removed from a group either.
		if(error.name === 'ObjectClassViolationError' || error.code === 65){
			return res.status(409).json({
				message: `"${req.params.child}" is the only member of "${req.params.group}". A group must keep at least one member — add another first.`
			});
		}
		next(error);
	}
});

router.put('/owner/:group/:uid', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		var group = await Group.get(req.params.group);
		var user = await User.get(req.params.uid);
		return res.json({
			results: await group.addOwner(user),
			message: `Added owner ${req.params.uid} to ${req.params.group} group.`
		});
	}catch(error){
		next(error);
	}
});

router.delete('/owner/:group/:uid', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		var group = await Group.get(req.params.group);
		var user = await User.get(req.params.uid);
		return res.json({
			results: await group.removeOwner(user),
			message: `Removed Owner ${req.params.uid} from ${req.params.group} group.`
		});
	}catch(error){
		next(error);
	}
});

router.put('/:group/:uid', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		var group = await Group.get(req.params.group);
		var user = await User.get(req.params.uid);
		const results = await group.addMember(user);
		// Group membership feeds directly into cached-User-derived state
		// (isServiceAccount, isAdmin, group-gated nav/UI) -- without this,
		// a membership change here is invisible for up to the cache's TTL.
		User.clearCache();
		return res.json({
			results,
			message: `Added user ${req.params.uid} to ${req.params.group} group.`
		});
	}catch(error){
		// Already a member -- surfaced as a plain 500 before, which read as a
		// server fault for what is really a no-op. Common in practice because
		// groupOfNames needs at least one member, so whoever creates a group is
		// seeded into it and is then "added" again by the obvious next click.
		if(error.name === 'TypeOrValueExistsError' || error.code === 20){
			return res.status(409).json({
				message: `"${req.params.uid}" is already a member of "${req.params.group}".`
			});
		}
		next(error);
	}
});

router.delete('/:group/:uid', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		var group = await Group.get(req.params.group);
		var user = await User.get(req.params.uid);
		const results = await group.removeMember(user);
		User.clearCache();
		return res.json({
			results,
			message: `Removed user ${req.params.uid} from ${req.params.group} group.`
		});
	}catch(error){
		next(error);
	}
});

router.delete('/:group', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		var group = await Group.get(req.params.group);
		return res.json({
			removed: await group.remove(),
			results: group,
			message: `Group ${req.params.group} Deleted`
		});
	}catch(error){
		next(error);
	}
});

module.exports = router;
