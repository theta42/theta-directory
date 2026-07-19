'use strict';

const { Client, Attribute, Change } = require('ldapts');
const { LRUCache } = require('lru-cache');
const conf = require('@simpleworkjs/conf').ldap;

// Escape a value used inside an LDAP search filter (RFC 4515).
function escapeLDAPSearchValue(val) {
	return String(val)
		.replace(/\\/g, '\\5c')
		.replace(/\*/g, '\\2a')
		.replace(/\(/g, '\\28')
		.replace(/\)/g, '\\29')
		.replace(/\0/g, '\\00');
}

// Escape a value used in an LDAP DN (RFC 4514). Defensive: usernames/cns
// are normally alphanumeric, but this prevents metacharacter injection.
function escapeLDAPDNValue(val) {
	return String(val)
		.replace(/\\/g, '\\\\')
		.replace(/,/g, '\\,')
		.replace(/\+/g, '\\+')
		.replace(/"/g, '\\"')
		.replace(/</g, '\\<')
		.replace(/>/g, '\\>')
		.replace(/;/g, '\\;')
		.replace(/=/g, '\\=')
		.replace(/^\s|\s$/g, match => match === ' ' ? '\\ ' : match);
}

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
	let memberFilter = member ? `(member=${escapeLDAPSearchValue(member)})`: ''

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
	const safeName = escapeLDAPDNValue(data.name);
	await client.add(`cn=${safeName},${conf.groupBase}`, {
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
		const safeName = escapeLDAPSearchValue(data.name);
		let group = (await client.search(conf.groupBase, {
			scope: 'sub',
			filter: `(&(objectClass=groupOfNames)(cn=${safeName}))`,
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
