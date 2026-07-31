'use strict';

const {Group} = require('../models/group_ldap');

const SUPER_ADMIN_GROUP = 'app_super_admin';

let byGroup = async function(user, groups, ownerOf){
	// Membership is resolved once, transitively: a user placed in an admin group
	// through a nested group is as much a member as one listed on it directly.
	// Checking `group.member.includes(user.dn)` per group -- as this used to --
	// only ever sees the literal member list and would deny them.
	let memberOfCns = [];
	try{
		memberOfCns = await Group.list(user.dn);
	}catch(error){
		// Fall through to the per-group checks below rather than hard-failing;
		// they still catch direct membership if the resolver is unavailable.
	}

	if(memberOfCns.includes(SUPER_ADMIN_GROUP)) return true;

	for(let group of groups){
		if(memberOfCns.includes(group)) return true;
	}

	// `owner` is deliberately NOT transitive. It designates accountable people,
	// and inheriting ownership through a nested group would hand approval rights
	// to anyone transitively in it -- an escalation nobody asked for.
	for(let group of ownerOf || []){
		try{
			group = await Group.get(group);
			if(group.owner.includes(user.dn)) return true
		}catch(error){
			// group not found, continue checking
		}
	}

	let error = new Error('Insufficient Permission');
	error.name = 'Insufficient Permission';
	error.message = `You do not have permission to perform this action.`;
	error.status = 401;
	throw error;
}

module.exports = {byGroup, SUPER_ADMIN_GROUP};
