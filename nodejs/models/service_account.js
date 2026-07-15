'use strict';

// Non-person "service" accounts under ou=people -- bind-only LDAP identities
// for things like theta-env's bootstrap-created cn=ldapclient (the proxy's
// direct-LDAP bind account) or any other app/host that needs its own
// dedicated read-only credential, as opposed to a real user who logs into
// the web UI.
//
// Deliberately NOT posixAccount/inetOrgPerson (the User model's shape) --
// these can't log into the SSO Manager UI or get a home directory/uidNumber.
// objectClass matches exactly what theta-env's bootstrap.js already creates
// for cn=ldapclient, so this model recognizes and manages that account too,
// not just ones created through this UI.

const { Client, Attribute, Change } = require('ldapts');
const crypto = require('crypto');
const conf = require('@simpleworkjs/conf').ldap;

function hashPasswordSSHA512(password) {
	const salt = crypto.randomBytes(8);
	const hash = crypto.createHash('sha512').update(password).update(salt).digest();
	return '{SSHA512}' + Buffer.concat([hash, salt]).toString('base64');
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

const FILTER = '(&(objectClass=organizationalRole)(objectClass=simpleSecurityObject))';
const CN_RE = /^[A-Za-z][A-Za-z0-9._-]{1,63}$/;

var ServiceAccount = {};

ServiceAccount.list = async function(){
	return withClient(async (client) => {
		const res = await client.search(conf.userBase, {
			scope: 'sub',
			filter: FILTER,
			attributes: ['cn', 'description', 'createTimestamp', 'modifyTimestamp'],
		});
		return res.searchEntries.map((entry) => ({
			cn: entry.cn,
			dn: `cn=${entry.cn},${conf.userBase}`,
			description: entry.description || '',
			created_on: entry.createTimestamp || null,
			modified_on: entry.modifyTimestamp || null,
		})).sort((a, b) => a.cn.localeCompare(b.cn));
	});
};

ServiceAccount.create = async function({cn, description}){
	if(!cn || !CN_RE.test(cn)){
		throw Object.assign(new Error('InvalidName'), {status: 400, message: 'Name must start with a letter and contain only letters, numbers, dot, dash, underscore.'});
	}

	const dn = `cn=${cn},${conf.userBase}`;
	const password = crypto.randomBytes(24).toString('base64url');

	await withClient(async (client) => {
		let existing = true;
		try{
			const res = await client.search(dn, {scope: 'base', filter: '(objectClass=*)', attributes: ['dn']});
			existing = res.searchEntries.length > 0;
		}catch(error){ existing = false; }
		if(existing){
			throw Object.assign(new Error('NameInUse'), {status: 409, message: `"${cn}" already exists under ${conf.userBase}.`});
		}

		await client.add(dn, {
			objectClass: ['organizationalRole', 'simpleSecurityObject', 'top'],
			cn,
			description: description || '',
			userPassword: hashPasswordSSHA512(password),
		});
	});

	return {cn, dn, description: description || '', password};
};

ServiceAccount.setPassword = async function(cn, password){
	const dn = `cn=${cn},${conf.userBase}`;
	const newPassword = password || crypto.randomBytes(24).toString('base64url');

	await withClient(async (client) => {
		await client.modify(dn, [
			new Change({
				operation: 'replace',
				modification: new Attribute({type: 'userPassword', values: [hashPasswordSSHA512(newPassword)]}),
			}),
		]);
	});

	return {cn, dn, password: newPassword};
};

ServiceAccount.remove = async function(cn){
	const dn = `cn=${cn},${conf.userBase}`;
	await withClient(async (client) => {
		await client.del(dn);
	});
	return true;
};

module.exports = {ServiceAccount};
