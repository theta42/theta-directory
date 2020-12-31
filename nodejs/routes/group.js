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

router.put('/owner/:group/:uid', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		var group = await Group.get(req.params.group);
		var user = await User.get(req.params.uid);
		return res.json({
			results: group.addOwner(user),
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
			results: group.removeOwner(user),
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
		return res.json({
			results: group.addMember(user),
			message: `Added user ${req.params.uid} to ${req.params.group} group.`
		});
	}catch(error){
		next(error);
	}
});

router.delete('/:group/:uid', async function(req, res, next){
	try{

		await permission.byGroup(req.user, ['app_sso_admin'], [req.params.group]);

		var group = await Group.get(req.params.group);
		var user = await User.get(req.params.uid);
		return res.json({
			results: group.removeMember(user),
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
