'use static';

const {Group} = require('../models/group_ldap');

let byGroup = async function(user, groups){
	for(let group of groups){
		try{
			group = await Group.get(group);
			if(group.member.includes(user.dn)) return true
		}catch(error){
			throw error;
		}

		let error = new Error('Insufficient Permission');
		error.name = 'Insufficient Permission';
		error.message = `You do not have permission to perform this action.`;
		error.status = 401;
		throw error;
	}
}

module.exports = {byGroup};
