'use static';

const {Group} = require('../models/group_ldap');

let byGroup = async function(user, groups, ownerOf){
	for(let group of groups){
		try{
			console.log('checking group', group, 'for access', groups, ownerOf)
			group = await Group.get(group);
			if(group.member.includes(user.dn)) return true
		}catch(error){
			console.error('Error byGroup', groups, ownerOf);
		}
	}

	for(let group of ownerOf || []){
		try{
			console.log('checking group owners', group, 'for access', groups, ownerOf)

			group = await Group.get(group);
			if(group.owner.includes(user.dn)) return true
		}catch(error){
			console.error('Error byGroup', groups, ownerOf);
		}
	}

	let error = new Error('Insufficient Permission');
	error.name = 'Insufficient Permission';
	error.message = `You do not have permission to perform this action.`;
	error.status = 401;
	throw error;
}

module.exports = {byGroup};
