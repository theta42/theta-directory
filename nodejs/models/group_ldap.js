'use strict';

const { Client, Attribute, Change } = require('ldapts');
const conf = require('../app').conf.ldap;

const client = new Client({
	url: conf.url,
});

async function getGroups(client, member){
	try{

		let memberFilter = member ? `(member=${member})`: ''

		let groups = (await client.search(conf.groupBase, {
			scope: 'sub',
			filter: `(&(objectClass=groupOfNames)${memberFilter})`,
			attributes: ['*', 'createTimestamp', 'modifyTimestamp'],
		})).searchEntries;

		return groups.map(function(group){
			if(!Array.isArray(group.member)) group.member = [group.member];
			if(!Array.isArray(group.owner)) group.owner = [group.owner];
			return group
		});
	}catch(error){
		throw error;
	}
}

async function addGroup(client, data){
	try{

		await client.add(`cn=${data.name},${conf.groupBase}`, {
			cn: data.name,
			member: data.owner,
			description: data.description,
			owner: data.owner,
			objectclass: [ 'groupOfNames', 'top'  ]
		});

		return data;

	}catch(error){
		throw error;
	}
}

async function addMember(client, group, user){
	try{
		await client.modify(group.dn, [
			new Change({
				operation: 'add',
				modification: new Attribute({
					type: 'member',
					values: [user.dn] 
				})
			}),
		]); 
	}catch(error){
		// if(error = "TypeOrValueExistsError"){
		// 	console.error('addMember error skipped', error)
		// 	return ;
		// }
		throw error;
	}
}

async function removeMember(client, group, user){
  try{
	await client.modify(group.dn, [
		new Change({
			operation: 'delete',
			modification: new Attribute({
				type: 'member',
				values: [user.dn] 
			})}),
		]); 
	}catch(error){
		if(error = "TypeOrValueExistsError")return ;
		throw error;
	}
}

async function addOwner(client, group, user){
	try{
		await client.modify(group.dn, [
			new Change({
				operation: 'add',
				modification: new Attribute({
					type: 'owner',
					values: [user.dn] 
				})
			}),
		]); 
	}catch(error){
		// if(error = "TypeOrValueExistsError"){
		// 	console.error('addMember error skipped', error)
		// 	return ;
		// }
		throw error;
	}
}

async function removeOwner(client, group, user){
  try{
	await client.modify(group.dn, [
		new Change({
			operation: 'delete',
			modification: new Attribute({
				type: 'owner',
				values: [user.dn] 
			})}),
		]); 
	}catch(error){
		if(error = "TypeOrValueExistsError")return ;
		throw error;
	}
}

var Group = {};

Group.list = async function(member){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		let groups = await getGroups(client, member)

		await client.unbind();

		return groups.map(group => group.cn);
	}catch(error){
		throw error;
	}
}

Group.listDetail = async function(member){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		let groups = await getGroups(client, member)

		await client.unbind();


		return groups;
	}catch(error){
		throw error;
	}
}

Group.get = async function(data){
	try{

		if(typeof data !== 'object'){
			let name = data;
			data = {};
			data.name = name;
		}
		
		await client.bind(conf.bindDN, conf.bindPassword);

		let group = (await client.search(conf.groupBase, {
			scope: 'sub',
			filter: `(&(objectClass=groupOfNames)(cn=${data.name}))`,
			attributes: ['*', 'createTimestamp', 'modifyTimestamp'],
		})).searchEntries[0];

		await client.unbind();

		if(!Array.isArray(group.member)) group.member = [group.member];
		if(!Array.isArray(group.owner)) group.owner = [group.owner];

		if(group){
			let obj = Object.create(this);
			Object.assign(obj, group);
			
			return obj;
		}else{
			let error = new Error('GroupNotFound');
			error.name = 'GroupNotFound';
			error.message = `LDAP:${data.cn} does not exists`;
			error.status = 404;
			throw error;
		}
	}catch(error){
		throw error;
	}
}

Group.add = async function(data){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		await addGroup(client, data);

		await client.unbind();

		return this.get(data);

	}catch(error){
		throw error;
	}
}

Group.addMember = async function(user){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		await addMember(client, this, user);

		await client.unbind();

		return this;

	}catch(error){
		throw error;
	}
};

Group.removeMember = async function(user){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		await removeMember(client, this, user);

		await client.unbind();

		return this;

	}catch(error){
		throw error;
	}
};


Group.addOwner = async function(user){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		await addOwner(client, this, user);

		await client.unbind();

		return this;

	}catch(error){
		throw error;
	}
};

Group.removeOwner = async function(user){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		await removeOwner(client, this, user);

		await client.unbind();

		return this;

	}catch(error){
		throw error;
	}
};

Group.remove = async function(){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		await client.del(this.dn);

		await client.unbind();

		return true;
	}catch(error){
		throw error;
	}
}

module.exports = {Group};
