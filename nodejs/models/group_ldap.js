'use strict';

const { Client, Attribute, Change } = require('ldapts');
const { LRUCache } = require('lru-cache');
const conf = require('@simpleworkjs/conf').ldap;

function makeClient() {
	return new Client({ url: conf.url });
}

async function withClient(fn) {
	const client = makeClient();
	try {
		await client.bind(conf.bindDN, conf.bindPassword);
		return await fn(client);
	} finally {
		await client.unbind().catch(() => {});
	}
}

async function getGroups(client, member){
	let memberFilter = member ? `(member=${member})`: ''

	let groups = (await client.search(conf.groupBase, {
		scope: 'sub',
		filter: `(&(objectClass=groupOfNames)${memberFilter})`,
		attributes: ['cn', 'description', 'member', 'owner', 'createTimestamp', 'modifyTimestamp'],
	})).searchEntries;

	return groups.map(function(group){
		if(!Array.isArray(group.member)) group.member = [group.member];
		if(!Array.isArray(group.owner)) group.owner = [group.owner];
		return group
	});
}

async function addGroup(client, data){
	await client.add(`cn=${data.name},${conf.groupBase}`, {
		cn: data.name,
		member: data.owner,
		description: data.description,
		owner: data.owner,
		objectclass: [ 'groupOfNames', 'top'  ]
	});

	return data;
}

async function addMember(client, group, user){
	await client.modify(group.dn, [
		new Change({
			operation: 'add',
			modification: new Attribute({
				type: 'member',
				values: [user.dn]
			})
		}),
	]);
}

async function removeMember(client, group, user){
	await client.modify(group.dn, [
		new Change({
			operation: 'delete',
			modification: new Attribute({
				type: 'member',
				values: [user.dn]
			})}),
		]);
}

async function addOwner(client, group, user){
	await client.modify(group.dn, [
		new Change({
			operation: 'add',
			modification: new Attribute({
				type: 'owner',
				values: [user.dn]
			})
		}),
	]);
}

async function removeOwner(client, group, user){
	await client.modify(group.dn, [
		new Change({
			operation: 'delete',
			modification: new Attribute({
				type: 'owner',
				values: [user.dn]
			})}),
		]);
}

const cache = new LRUCache({ max: 1, ttl: 1000 * 60 * 5, ttlAutopurge: true });

async function cachedListDetail() {
	const hit = cache.get('all');
	if (hit) return hit;
	const promise = withClient(async (client) => {
		const groups = await getGroups(client);
		return groups.map(g => ({...g}));
	}).then(plain => {
		cache.set('all', plain);
		return plain;
	}).catch(err => {
		cache.delete('all');
		throw err;
	});
	// Store promise immediately to prevent stampede on concurrent requests
	cache.set('all', promise);
	return promise;
}

var Group = {};

Group.list = async function(member){
	if (member) {
		return withClient(async (client) => {
			const groups = await getGroups(client, member);
			return groups.map(group => group.cn);
		});
	}
	return (await cachedListDetail()).map(group => group.cn);
}

Group.listDetail = async function(member){
	if (member) {
		return withClient(async (client) => getGroups(client, member));
	}
	return cachedListDetail();
}

Group.get = async function(data){
	if(typeof data !== 'object'){
		let name = data;
		data = {};
		data.name = name;
	}

	return withClient(async (client) => {
		let group = (await client.search(conf.groupBase, {
			scope: 'sub',
			filter: `(&(objectClass=groupOfNames)(cn=${data.name}))`,
			attributes: ['cn', 'description', 'member', 'owner', 'createTimestamp', 'modifyTimestamp'],
		})).searchEntries[0];

		if(group){
			if(!Array.isArray(group.member)) group.member = [group.member];
			if(!Array.isArray(group.owner)) group.owner = [group.owner];
			let obj = Object.create(this);
			Object.assign(obj, group);
			return obj;
		}else{
			let error = new Error('GroupNotFound');
			error.name = 'GroupNotFound';
			error.message = `LDAP:${data.name} does not exists`;
			error.status = 404;
			throw error;
		}
	});
}

Group.add = async function(data){
	return withClient(async (client) => {
		await addGroup(client, data);
		cache.clear();
		return this.get(data);
	});
}

Group.addMember = async function(user){
	await withClient(async (client) => addMember(client, this, user));
	this.member = [].concat(this.member || []).concat([user.dn]);
	cache.clear();
	return this;
};

Group.removeMember = async function(user){
	try{
		await withClient(async (client) => removeMember(client, this, user));
	}catch(error){
		if(error.name === "NoSuchAttributeError") return this;
		throw error;
	}
	this.member = [].concat(this.member || []).filter(dn => dn !== user.dn);
	cache.clear();
	return this;
};

Group.addOwner = async function(user){
	await withClient(async (client) => addOwner(client, this, user));
	this.owner = [].concat(this.owner || []).concat([user.dn]);
	cache.clear();
	return this;
};

Group.removeOwner = async function(user){
	try{
		await withClient(async (client) => removeOwner(client, this, user));
	}catch(error){
		if(error.name === "NoSuchAttributeError") return this;
		throw error;
	}
	this.owner = [].concat(this.owner || []).filter(dn => dn !== user.dn);
	cache.clear();
	return this;
};

Group.remove = async function(){
	await withClient(async (client) => client.del(this.dn));
	cache.clear();
	return true;
}

module.exports = {Group};
