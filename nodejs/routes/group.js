'use strict';

const router = require('express').Router();
const {User} = require('../models/user_ldap');
const {Group} = require('../models/group_ldap'); 

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

router.put('/:name/:uid', async function(req, res, next){
	try{
		var group = await Group.get(req.params.name);
		var user = await User.get(req.params.uid);
		return res.json({
			results: group.addMember(user),
			message: `Added user ${req.params.uid} to ${req.params.name} group.`
		});
	}catch(error){
		next(error);
	}
});

router.delete('/:name/:uid', async function(req, res, next){
	try{
		var group = await Group.get(req.params.name);
		var user = await User.get(req.params.uid);
		return res.json({
			results: group.removeMember(user),
			message: `Removed user ${req.params.uid} from ${req.params.name} group.`
		});
	}catch(error){
		next(error);
	}
});

router.delete('/:name', async function(req, res, next){
	try{
		var group = await Group.get(req.params.name);
		return res.json({
			removed: await group.remove(),
			results: group,
			message: `Group ${req.params.name} Deleted`
		});
	}catch(error){
		next(error);
	}
});

module.exports = router;
