'use strict';

const {Group} = require('../models/group_ldap');

const SUPER_ADMIN_GROUP = 'app_super_admin';

let byGroup = async function(user, groups, ownerOf){
	try{
		let superAdmin = await Group.get(SUPER_ADMIN_GROUP);
		if(superAdmin.member.includes(user.dn)) return true
	}catch(error){
		// group not found, continue checking
	}

	for(let group of groups){
		try{
			group = await Group.get(group);
			if(group.member.includes(user.dn)) return true
		}catch(error){
			// group not found, continue checking
		}
	}

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
