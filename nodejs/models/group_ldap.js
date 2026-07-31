'use strict';

const { Client, Attribute, Change } = require('ldapts');
const { LRUCache } = require('lru-cache');
const conf = require('@simpleworkjs/conf').ldap;
// Connection + escaping from the shared @simpleworkjs/ldap package. Local
// wrappers preserve the no-arg call signatures; see user_ldap.js for rationale.
const { makeClient: _makeClient, withClient: _withClient, escapeFilter, escapeDN } = require('@simpleworkjs/ldap');
const escapeLDAPSearchValue = escapeFilter;
const escapeLDAPDNValue = escapeDN;

function makeClient() {
	return _makeClient(conf);
}

async function withClient(fn) {
	return _withClient(conf, fn);
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

// --- Nested groups -------------------------------------------------------
//
// `groupOfNames.member` holds DNs, and nothing says those DNs must be users --
// a group DN is a perfectly legal member. That is how nesting is stored here:
// as-is, no extra schema, no denormalization, the nesting visible in LDAP
// exactly as an admin entered it.
//
// What LDAP will NOT do is resolve it. The memberof overlay records only
// *direct* membership, and a `(member=<dn>)` filter likewise finds only the
// groups that list the DN literally. So transitivity is computed here, and
// every membership question in the app must go through these helpers or it
// will silently see one level and grant nothing for a nested group.
//
// The whole group set is one subtree search, so the closure is computed in
// memory rather than issuing a query per level. `resolverCache` keeps that
// search off the hot path for bursts; it is cleared by every write below, so
// the only staleness it can introduce is from edits made outside this app.
// Auth decisions ride on this, hence the deliberately short TTL.

const NESTING_TTL_MS = 15 * 1000;
const MAX_NESTING_DEPTH = Number(conf.groupNestingDepth) > 0 ? Number(conf.groupNestingDepth) : 10;

const resolverCache = new LRUCache({ max: 1, ttl: NESTING_TTL_MS, ttlAutopurge: true });

async function allGroupsForResolver() {
	const hit = resolverCache.get('all');
	if (hit) return hit;
	const promise = withClient(async (client) => {
		const groups = await getGroups(client);
		return groups.map(g => ({ ...g }));
	}).then(plain => {
		resolverCache.set('all', plain);
		return plain;
	}).catch(err => {
		resolverCache.delete('all');
		throw err;
	});
	resolverCache.set('all', promise);
	return promise;
}

const lc = dn => String(dn || '').toLowerCase();

// dn -> [groups that list dn as a member]. One pass, reused for every lookup.
function buildParentIndex(groups) {
	const parents = new Map();
	for (const group of groups) {
		for (const member of [].concat(group.member || []).filter(Boolean)) {
			const key = lc(member);
			if (!parents.has(key)) parents.set(key, []);
			parents.get(key).push(group);
		}
	}
	return parents;
}

// Every group `dn` belongs to, directly or through any chain of nested groups.
// Breadth-first with a visited set, so a cycle (A in B, B in A) terminates
// instead of hanging, and MAX_NESTING_DEPTH bounds a pathological chain.
function closureUp(dn, groups) {
	const parents = buildParentIndex(groups);
	const found = new Map(); // cn -> group
	const seen = new Set([lc(dn)]);
	let frontier = [lc(dn)];

	for (let depth = 0; depth < MAX_NESTING_DEPTH && frontier.length; depth++) {
		const next = [];
		for (const current of frontier) {
			for (const group of parents.get(current) || []) {
				const groupDn = lc(group.dn);
				if (seen.has(groupDn)) continue;
				seen.add(groupDn);
				found.set(group.cn, group);
				// The group itself is now a member to look up: this is the step
				// that makes the walk transitive rather than one-level.
				next.push(groupDn);
			}
		}
		frontier = next;
	}
	return [...found.values()];
}

// Every member DN reachable from a group, split into the users it effectively
// grants and the groups it nests. `direct` is kept separate so the UI can show
// "3 members, 12 effective" and so removal stays unambiguous.
function closureDown(group, groups) {
	const byDn = new Map(groups.map(g => [lc(g.dn), g]));
	const users = new Set();
	const nested = new Map();
	const seen = new Set([lc(group.dn)]);
	let frontier = [group];

	for (let depth = 0; depth < MAX_NESTING_DEPTH && frontier.length; depth++) {
		const next = [];
		for (const current of frontier) {
			for (const member of [].concat(current.member || []).filter(Boolean)) {
				const key = lc(member);
				const asGroup = byDn.get(key);
				if (asGroup) {
					if (seen.has(key)) continue;
					seen.add(key);
					nested.set(asGroup.cn, asGroup);
					next.push(asGroup);
				} else {
					users.add(member);
				}
			}
		}
		frontier = next;
	}
	return { users: [...users], nested: [...nested.values()] };
}

var Group = {};

// Set when slapd carries the nestgroup overlay (docker-entrypoint.sh exports
// app_ldap__nestedGroupsServerSide=true after detecting nestgroup.so). With it,
// a plain `(member=<dn>)` search already returns the full transitive set and the
// in-app closure is redundant work on every request. Without it -- e.g. pointed
// at a stock 2.6.x server, which no release ships nestgroup in -- the app must
// compute the closure itself or nested groups silently grant nothing.
const SERVER_SIDE_NESTING = String(conf.nestedGroupsServerSide) === 'true';

// Transitive: every group CN this member belongs to, at any nesting depth.
// Callers making an access decision must use this rather than reading
// `memberOf`, which a server without nestgroup only ever populates one level
// deep.
Group.list = async function(member){
	if (member) {
		if (SERVER_SIDE_NESTING) {
			return withClient(async (client) => {
				const groups = await getGroups(client, member);
				return groups.map(group => group.cn);
			});
		}
		const groups = await allGroupsForResolver();
		return closureUp(member, groups).map(group => group.cn);
	}
	return (await cachedListDetail()).map(group => group.cn);
}

// The members a group effectively grants: users reached through any chain of
// nested groups, plus the nested groups themselves for display.
Group.effectiveMembers = async function(cn){
	const groups = await allGroupsForResolver();
	const group = groups.find(g => g.cn === cn);
	if (!group) {
		let error = new Error('GroupNotFound');
		error.name = 'GroupNotFound';
		error.message = `LDAP:${cn} does not exists`;
		error.status = 404;
		throw error;
	}
	const { users, nested } = closureDown(group, groups);
	const directMembers = [].concat(group.member || []).filter(Boolean);
	const groupDns = new Set(groups.map(g => lc(g.dn)));
	return {
		cn: group.cn,
		direct: directMembers.filter(dn => !groupDns.has(lc(dn))),
		nestedGroups: nested.map(g => ({ cn: g.cn, dn: g.dn })),
		effective: users,
	};
};

// Would adding `childDn` to `parentCn` create a cycle? A group may not contain
// itself, nor anything that already (transitively) contains it -- such a chain
// makes membership unanswerable, and callers would rely on the depth cap to
// stop rather than getting a real answer.
Group.wouldCycle = async function(parentCn, childDn){
	const groups = await allGroupsForResolver();
	const parent = groups.find(g => g.cn === parentCn);
	if (!parent) return false;
	if (lc(parent.dn) === lc(childDn)) return true;
	const child = groups.find(g => lc(g.dn) === lc(childDn));
	if (!child) return false; // a user DN can never close a cycle
	// Adding child under parent is a cycle exactly when parent is already
	// reachable downward from child.
	const { nested } = closureDown(child, groups);
	return nested.some(g => lc(g.dn) === lc(parent.dn));
};

Group.clearResolverCache = function(){ resolverCache.clear(); };

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
		resolverCache.clear();
		return this.get(data);
	});
}

Group.addMember = async function(user){
	await withClient(async (client) => addMember(client, this, user));
	this.member = [].concat(this.member || []).concat([user.dn]);
	cache.clear();
	resolverCache.clear();
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
	resolverCache.clear();
	return this;
};

Group.addOwner = async function(user){
	await withClient(async (client) => addOwner(client, this, user));
	this.owner = [].concat(this.owner || []).concat([user.dn]);
	cache.clear();
	resolverCache.clear();
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
	resolverCache.clear();
	return this;
};

Group.remove = async function(){
	await withClient(async (client) => client.del(this.dn));
	cache.clear();
	resolverCache.clear();
	return true;
}

module.exports = {Group};
