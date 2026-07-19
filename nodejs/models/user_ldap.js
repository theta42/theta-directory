'use strict';

const { Client, Attribute, Change } = require('ldapts');
const { LRUCache } = require('lru-cache');
const crypto = require('crypto');

const {Mail} = require('./email');
const {Token, InviteToken, PasswordResetToken} = require('./token');
const {Group} = require('./group_ldap');
const {UserVerification} = require('./verification');
const conf = require('@simpleworkjs/conf').ldap;

function hashPasswordSSHA512(password) {
	const salt = crypto.randomBytes(8);
	const hash = crypto.createHash('sha512').update(password).update(salt).digest();
	return '{SSHA512}' + Buffer.concat([hash, salt]).toString('base64');
}

const cache = new LRUCache({
	// how long to live in ms
	ttlAutopurge: true,
  ttl: 1000 * 60 * 5,
});

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

// Helper to escape LDAP filter values (crucial for security)
function escapeLDAPSearchValue(val) {
    return val.replace(/\\/g, '\\5c')
              .replace(/\*/g, '\\2a')
              .replace(/\(/g, '\\28')
              .replace(/\)/g, '\\29')
              .replace(/\0/g, '\\00');
}

// Escape a value used in an LDAP DN (RFC 4514).
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

// Compute the next available uid/gidNumber: the highest existing value below
// conf.uidGidReservedFloor, plus one -- or conf.uidGidMin if there are no
// such entries yet. Entries at/above the reserved floor (e.g. a bootstrap
// admin deliberately given a high, easily-recognizable id -- see
// theta-env's bootstrap.js) are ignored, so they don't drag every real
// user's id up into that same range. Math.max() on an empty array is
// -Infinity in JS, not 0 -- without the explicit floor here, a fresh
// directory with zero existing entries produces an invalid ("-Infinity")
// LDAP attribute value and the add fails with InvalidSyntaxError.
function nextPosixId(entries, key){
	const existing = entries
		.map(i => Number(i[key]))
		.filter(n => Number.isFinite(n) && n < conf.uidGidReservedFloor);

	return String(Math.max(conf.uidGidMin - 1, ...existing) + 1);
}

async function addPosixGroup(client, data){

  try{
	const groups = (await client.search(conf.groupBase, {
	  scope: 'sub',
	  filter: '(&(objectClass=posixGroup))',
	})).searchEntries;

	data.gidNumber = nextPosixId(groups, 'gidNumber');

	const safeCn = escapeLDAPDNValue(data.cn);
	await client.add(`cn=${safeCn},${conf.groupBase}`, {
	  cn: data.cn,
	  gidNumber: data.gidNumber,
	  objectclass: [ 'posixGroup', 'top' ]
	});

	return data;

  }catch(error){
	throw error;
  }
}

async function addPosixAccount(client, data){
  try{
	const people = (await client.search(conf.userBase, {
		scope: 'sub',
		filter: conf.userFilter,
	})).searchEntries;

	data.uidNumber = nextPosixId(people, 'uidNumber');

	const safeCn = escapeLDAPDNValue(data.cn);
	const entry = {
		cn: data.cn,
		sn: data.sn,
		uid: data.uid,
		uidNumber: data.uidNumber,
		gidNumber: data.gidNumber,
		givenName: data.givenName,
		loginShell: data.loginShell,
		homeDirectory: data.homeDirectory,
		description: data.description || ' ',
		sudoHost: 'ALL',
		sudoCommand: 'ALL',
		sudoUser: data.uid,
		objectclass: ['inetOrgPerson', 'sudoRole', 'ldapPublicKey', 'posixAccount', 'top', 'theta42Person'],
	};

	// mail is optional in the inetOrgPerson schema, but ldapts/slapd reject an
	// attribute given an explicit undefined value ("no values for attribute
	// type") rather than just omitting it -- service accounts (a Unix account
	// an app/service runs as) commonly have no real mailbox.
	if (data.mail) {
		entry.mail = data.mail;
	}

	if (data.mobile) {
		entry.mobile = data.mobile;
	}

	if (data.sshPublicKey) {
		entry.sshPublicKey = data.sshPublicKey;
	}

	if (data.dob) {
		entry.dateOfBirth = data.dob;
	}

	// userPassword is optional -- a service account with no password set
	// simply can't bind (no special enforcement needed, that's the default
	// LDAP simple-bind behavior for an entry lacking the attribute).
	if (data.userPassword) {
		entry.userPassword = data.userPassword;
	}

	// manager (COSINE, SUP distinguishedName) is naturally multi-valued --
	// every account gets at least the DN of whoever created it.
	if (data.manager && [].concat(data.manager).length) {
		entry.manager = [].concat(data.manager);
	}

	await client.add(`cn=${safeCn},${conf.userBase}`, entry);

	return data

  }catch(error){
	throw error;
  }

}

async function addLdapUser(client, data){

	var group;


	try{
		if (!data.uid) {
			data.uid = `${data.givenName[0]}${data.sn}`.toLowerCase();
		}
		data.cn = data.uid;
		data.loginShell = data.loginShell || '/bin/bash';
		data.homeDirectory = data.homeDirectory || `/home/${data.uid}`;
		if (data.userPassword) {
			data.userPassword = hashPasswordSSHA512(data.userPassword);
		} else {
			delete data.userPassword;
		}

		group = await addPosixGroup(client, data);
		data = await addPosixAccount(client, group);

		return data;

	}catch(error){
		await deleteLdapDN(client, `cn=${data.uid},${conf.groupBase}`, true);
		throw error;
	}
}

async function deleteLdapUser(client, data){
	try{
		await client.del(`cn=${data.cn},${conf.groupBase}`);
	}catch(error){
		if (error.code !== 0x20) throw error; // ignore NoSuchObject — personal group may not exist
	}
	await client.del(data.dn);
}

async function deleteLdapDN(client, dn, ignoreError){
	try{
		await client.del(dn);
	}catch(error){
		if(!ignoreError) throw error;
		console.error('ERROR: deleteLdapDN', error)
	}
}

const user_parse = function(data){
	if(data[conf.userNameAttribute]){
		data.username = data[conf.userNameAttribute]
		data.userPassword = undefined;
	}
	// Use truthy strings so jq-repeat section blocks ({{#isActive}}) fire correctly
	data.isActive   = data.pwdAccountLockedTime ? '' : 'active';
	data.isInactive = data.pwdAccountLockedTime ? 'inactive' : '';

	// manager (COSINE, SUP distinguishedName) and memberOf (from the memberof
	// overlay) are both multi-valued; ldapts returns a bare string for a
	// single value and an array for multiple -- normalize both to always be
	// an array, or app-base.js's `for(let group of user.memberOf)` silently
	// iterates a single DN string character-by-character instead of once.
	data.manager   = [].concat(data.manager || []).filter(Boolean);
	data.memberOf  = [].concat(data.memberOf || []).filter(Boolean);

	return data;
}

var User = {}

User.backing = "LDAP";

User.clearCache = function() { cache.clear(); };

User.list = async function(){
	try{
		return await withClient(async (client) => {
			const res = await client.search(conf.userBase, {
			  scope: 'sub',
			  filter: conf.userFilter,
			  attributes: ['*', '+'],
			});
			return res.searchEntries.map(function(user){return user.uid});
		});
	}catch(error){
		throw error;
	}
};

User.listDetail = async function(){
	try{
		const hit = cache.get('__list__');
		if (hit) return hit;

		const searchEntries = await withClient(async (client) => {
			const res = await client.search(conf.userBase, {
			  scope: 'sub',
			  filter: conf.userFilter,
			  attributes: ['*', '+'],
			});
			return res.searchEntries;
		});

		// Members of app_sso_service_account are non-person accounts (media
		// managers, app service users, ...) -- fetched once here rather than
		// relying on the memberof overlay's reverse attribute, which isn't
		// reliably returned by every LDAP server this app might point at.
		let serviceAccountDNs = new Set();
		try{
			const svcGroup = await Group.get('app_sso_service_account');
			serviceAccountDNs = new Set((svcGroup.member || []).map(dn => dn.toLowerCase()));
		}catch(error){ /* group not seeded yet on an old deployment -- treat as none */ }

		const dnToUid = new Map(searchEntries.map(e => [String(e.dn).toLowerCase(), e.uid]));

		const users = await Promise.all(searchEntries.map(async (entry) => {
			const rawPassword = entry.userPassword ? entry.userPassword.toString() : '';
			const isLegacyMD5 = rawPassword.toUpperCase().startsWith('{MD5}');

			let obj = Object.create(this);
			Object.assign(obj, user_parse(entry));

			const verif = await UserVerification.getOrCreate(obj.uid);

			if (isLegacyMD5 && !verif.password_must_change) {
				await verif.update({ password_must_change: true });
			}

			const passwordMustChange = isLegacyMD5 || verif.password_must_change;

			obj.emailVerified      = verif.email_verified ? 'verified' : '';
			obj.phoneVerified      = verif.phone_verified ? 'verified' : '';
			obj.tosAccepted        = verif.tos_accepted   ? 'accepted' : '';
			obj.tosNotAccepted     = verif.tos_accepted   ? '' : 'pending';
			obj.passwordMustChange = passwordMustChange   ? 'yes' : '';
			obj.onboardingNeeds    = [
				!verif.tos_accepted && 'tos',
				!obj.dateOfBirth    && 'dob',
				passwordMustChange  && 'password',
			].filter(Boolean);
			obj.onboardingRequired = obj.onboardingNeeds.length > 0 ? 'yes' : '';
			obj.isServiceAccount   = serviceAccountDNs.has(String(obj.dn).toLowerCase()) ? 'yes' : '';
			obj.managerUids        = obj.manager.map(dn => dnToUid.get(String(dn).toLowerCase()) || dn);

			return obj;
		}));

		cache.set('__list__', users);
		return users;

	}catch(error){
		throw error;
	}
};


User.get = async function(data, key) {
    if (typeof data !== 'object') {
        data = { uid: data };
    }

    const searchKey = data.searchKey || key || conf.userNameAttribute;
    const searchValue = escapeLDAPSearchValue(data.searchValue || data.uid);
    const filter = `(&${conf.userFilter}(${searchKey}=${searchValue}))`;

    // Check cache for an existing result or active promise
    const cached = cache.get(filter);
    if (cached) return cached;

    // Define the execution logic as a discrete promise
    const fetchPromise = (async () => {
        const res = await withClient(async (client) => {
            return await client.search(conf.userBase, {
                scope: 'sub',
                filter: filter,
                attributes: ['*', '+'],
            });
        });

        const user = res.searchEntries[0];

        if (!user) {
            let error = new Error('UserNotFound');
            error.name = 'UserNotFound';
            error.message = `LDAP:${searchValue} does not exist`;
            error.status = 404;
            throw error;
        }

        // Check password hash type before user_parse wipes the field
        const rawPassword = user.userPassword ? user.userPassword.toString() : '';
        const isLegacyMD5 = rawPassword.toUpperCase().startsWith('{MD5}');

        let obj = Object.create(this);
        Object.assign(obj, user_parse(user));

        const verif = await UserVerification.getOrCreate(obj.uid);

        // Same membership check as User.listDetail() -- see the comment there.
        try{
            const svcGroup = await Group.get('app_sso_service_account');
            const serviceAccountDNs = new Set((svcGroup.member || []).map(dn => dn.toLowerCase()));
            obj.isServiceAccount = serviceAccountDNs.has(String(obj.dn).toLowerCase()) ? 'yes' : '';
        }catch(error){ obj.isServiceAccount = ''; }

        // Auto-flag legacy MD5 password users — persist so subsequent cache hits see it
        if (isLegacyMD5 && !verif.password_must_change) {
            await verif.update({ password_must_change: true });
        }

        const passwordMustChange = isLegacyMD5 || verif.password_must_change;

        obj.emailVerified      = verif.email_verified ? 'verified' : '';
        obj.phoneVerified      = verif.phone_verified ? 'verified' : '';
        obj.tosAccepted        = verif.tos_accepted   ? 'accepted' : '';
        obj.tosNotAccepted     = verif.tos_accepted   ? '' : 'pending';
        obj.passwordMustChange = passwordMustChange   ? 'yes' : '';
        obj.onboardingNeeds    = [
            !verif.tos_accepted && 'tos',
            !obj.dateOfBirth    && 'dob',
            passwordMustChange  && 'password',
        ].filter(Boolean);
        obj.onboardingRequired = obj.onboardingNeeds.length > 0 ? 'yes' : '';

        // Replace the promise in the cache with the actual parsed object
        cache.set(filter, obj);
        return obj;
    })();

    // Cache the promise immediately to prevent stampedes
    cache.set(filter, fetchPromise);

    // If the promise fails, evict it from the cache immediately
    fetchPromise.catch(() => {
        cache.delete(filter);
    });

    return fetchPromise;
};

User.exists = async function(data, key){
	try{
		return await this.get(data, key);
	}catch(error){
		return null;
	}
};

User.add = async function(data) {
	try{
		if (await this.exists(data.mail, 'mail')) {
			throw Object.assign(new Error('Email already in use'), {status: 409, name: 'EmailInUse'});
		}
		if (data.mobile && await this.exists(data.mobile, 'mobile')) {
			throw Object.assign(new Error('Phone number already in use'), {status: 409, name: 'PhoneInUse'});
		}

		await withClient(async (client) => {
			await addLdapUser(client, data);
		});
		cache.clear();

		let user = await this.get(data.uid);

		await UserVerification.getOrCreate(user.uid);

		try {
			await Mail.sendTemplate(
				user.mail,
				'welcome',
				{
					user: user
				}
			);
		} catch(mailErr) {
			console.error(`User.add: welcome email failed for ${user.uid}:`, mailErr.message);
		}

		return user;

	}catch(error){
		if(error.message && error.message.includes('exists')){
			let err = new Error('UserNameUsed');
			err.name = 'UserNameUsed';
			err.message = `LDAP:${data.uid} already exists`;
			err.status = 409;

			throw err;
		}
		throw error;
	}
};

User.update = async function(data){
	try{
		if (data.mobile) {
			const existing = await User.exists(data.mobile, 'mobile');
			if (existing && existing.uid !== this.uid) {
				throw Object.assign(new Error('Phone number already in use'), {status: 409, name: 'PhoneInUse'});
			}
		}

		let editableFeilds = ['mobile', 'description', 'homeDirectory', 'loginShell'];

		await withClient(async (client) => {
			for(let field of editableFeilds){
				if(data[field]){
					await client.modify(this.dn, [
						new Change({
							operation: 'replace',
							modification: new Attribute({
								type: field,
								values: [data[field]]
							})
						}),
					]);
					this[field] = data[field];
				}
			}

			if(data.sshPublicKey){
				await client.modify(this.dn, [
					new Change({
						operation: 'replace',
						modification: new Attribute({ type: 'sshPublicKey', values: [data.sshPublicKey] }),
					}),
				]);
				this.sshPublicKey = data.sshPublicKey;
			}

			if(data.dateOfBirth){
				// Ensure the auxiliary objectClass is present before setting the attribute
				try {
					await client.modify(this.dn, [
						new Change({
							operation: 'add',
							modification: new Attribute({ type: 'objectClass', values: ['theta42Person'] }),
						}),
					]);
				} catch(e) {
					if(e.name !== 'TypeOrValueExistsError') throw e;
				}
				await client.modify(this.dn, [
					new Change({
						operation: 'replace',
						modification: new Attribute({ type: 'dateOfBirth', values: [data.dateOfBirth] }),
					}),
				]);
				this.dateOfBirth = data.dateOfBirth;
			}

			if(data.manager !== undefined){
				// Client sends uids; resolve each to a DN before writing --
				// manager (COSINE, SUP distinguishedName) stores DNs, not uids.
				const uids = [].concat(data.manager || []).filter(Boolean);
				const managers = await Promise.all(uids.map(uid => User.get(uid)));
				const dns = managers.map(u => u.dn);
				await client.modify(this.dn, [
					new Change({
						operation: 'replace',
						modification: new Attribute({ type: 'manager', values: dns }),
					}),
				]);
				this.manager = dns;
			}
		});
		cache.clear();

		return this;

	}catch(error){
		throw error;
	}
};

User.usernameSuggestions = async function(givenName, sn, dob) {
	const fn = (givenName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	const ln = (sn || '').toLowerCase().replace(/[^a-z0-9]/g, '');
	if (!fn || !ln) return [];
	const gi = fn[0];
	const li = ln[0];

	const candidates = [
		`${gi}${ln}`,     // jsmith
		`${fn}${ln}`,     // johnsmith
		`${fn}_${ln}`,    // john_smith
		`${fn}${li}`,     // johns
		`${ln}${gi}`,     // smithj
	];

	if (dob) {
		const year = new Date(dob).getFullYear();
		if (!isNaN(year)) {
			const y4 = String(year);
			const y2 = y4.slice(2);
			candidates.push(
				`${gi}${ln}${y2}`,  // jsmith90
				`${fn}${ln}${y2}`,  // johnsmith90
				`${fn}_${ln}${y2}`, // john_smith90
				`${gi}${ln}${y4}`,  // jsmith1990
				`${fn}${ln}${y4}`,  // johnsmith1990
				`${fn}_${ln}${y4}`, // john_smith1990
			);
		}
	}

	const available = [];
	for (const uid of [...new Set(candidates)]) {
		if (!(await this.exists(uid))) available.push(uid);
	}
	if (!available.length) {
		for (let i = 2; i <= 9; i++) {
			const uid = `${gi}${ln}${i}`;
			if (!(await this.exists(uid))) { available.push(uid); break; }
		}
	}
	return available;
};

User.addByInvite = async function(data){
	try{
		let token = await InviteToken.get(data.token);

		if(!token.is_valid && data.mailToken !== token.mail_token){
			let error = new Error('Token Invalid');
			error.name = 'Token Invalid';
			error.message = `Token is not valid or as allready been used. ${data.token}`;
			error.status = 401;
			throw error;
		}

		data.mail = token.mail;

		// Default manager: whoever sent the invite.
		try {
			const inviter = await this.get(token.created_by);
			data.manager = [inviter.dn];
		} catch(e) { /* inviter no longer exists -- leave manager unset */ }

		const suggestions = await this.usernameSuggestions(data.givenName, data.sn, data.dob);
		if (!data.uid || !suggestions.includes(data.uid)) {
			const err = new Error('Invalid username selection');
			err.status = 400;
			throw err;
		}

		let user = await this.add(data);

		if(user){
			await token.consume({claimed_by: user.uid});
			const verif = await UserVerification.getOrCreate(user.uid);
			await verif.markEmailVerified();
			await verif.markTosAccepted();
			await verif.update({ password_must_change: false });
			cache.clear(); // evict the cached user so the next get() reads fresh verification flags

			const groupNames = JSON.parse(token.groups || '[]');
			for (const groupName of groupNames) {
				try {
					const group = await Group.get(groupName);
					await group.addMember(user);
				} catch(e) {
					console.error(`invite: could not add ${user.uid} to group ${groupName}:`, e.message);
				}
			}

			return user;
		}

	}catch(error){
		throw error;
	}

};

User.verifyEmail = async function(data){
	try{

		let exists = await this.exists(data.mail, 'mail');

		if(exists) throw new Error('EmailInUse');

		let token = await InviteToken.get(data.token);
		const mail_token = crypto.randomUUID();
		await token.update({mail: data.mail, mail_token});

		try {
			await Mail.sendTemplate(
				data.mail,
				'validate_link',
				{
					link:`${data.url}/login/invite/${token.token}/${token.mail_token}`
				}
			);
		} catch(mailErr) {
			console.error(`verifyEmail: email failed for ${data.mail}:`, mailErr.message);
		}

		return this;
	}catch(error){
		throw error;
	}
};

User.passwordReset = async function(url, mail){
	try{

		let user = await User.get({
			searchKey: 'mail',
			searchValue: mail
		});

		let token = await PasswordResetToken.create({created_by: user.uid});

		try {
			await Mail.sendTemplate(
				user.mail,
				'reset_link',
				{
					user: user,
					link:`${url}/login/resetpassword/${token.token}`
				}
			);
		} catch(mailErr) {
			console.error(`passwordReset: email failed for ${user.uid}:`, mailErr.message);
		}

		return true;
	}catch(error){
		// if(error.name === 'UserNotFound') return false;
		throw error;
	}
};


User.remove = async function(data){
	try{

		await withClient(async (client) => {
			await deleteLdapUser(client, this);
		});
		cache.clear();

		return true;

	}catch(error){
		throw error;
	}
};

User.setPassword = async function(data){
	try{

		await withClient(async (client) => {
			await client.modify(this.dn, [
			  new Change({
				operation: 'replace',
				modification: new Attribute({
				  type: 'userPassword',
				  values: [hashPasswordSSHA512(data.userPassword)]
				})}),
			]); 
		});

		return this;
	}catch(error){
		throw error;
	}
};

User.addTempPassword = async function(hash) {
	await withClient(async (client) => {
		await client.modify(this.dn, [
			new Change({ operation: 'add', modification: new Attribute({ type: 'userPassword', values: [hash] }) }),
		]);
	});
};

User.removeTempPassword = async function(hash) {
	await withClient(async (client) => {
		await client.modify(this.dn, [
			new Change({ operation: 'delete', modification: new Attribute({ type: 'userPassword', values: [hash] }) }),
		]);
	});
};

User.setActive = async function(active) {
	try {
		await withClient(async (client) => {
			if (active) {
				await client.modify(this.dn, [
					new Change({ operation: 'delete', modification: new Attribute({ type: 'pwdAccountLockedTime', values: [] }) }),
				]);
			} else {
				await client.modify(this.dn, [
					new Change({ operation: 'replace', modification: new Attribute({ type: 'pwdAccountLockedTime', values: ['000001010000Z'] }) }),
				]);
			}
		});
	} catch (e) {
		if (active && e.name === 'NoSuchAttributeError') {
			// Already active — nothing to do
		} else if (e.name === 'UndefinedTypeError' || (e.message && e.message.includes('pwdAccountLockedTime'))) {
			const err = new Error('OpenLDAP ppolicy overlay is not configured. See README for setup instructions.');
			err.status = 503;
			throw err;
		} else {
			throw e;
		}
	}
	this.pwdAccountLockedTime = active ? undefined : '000001010000Z';
	this.isActive   = active ? 'active' : '';
	this.isInactive = active ? '' : 'inactive';
	cache.clear();
	return this;
};

User.addSSHkey = async function(data) {
	const user = await this.get(data.uid);
	let result;
	try {
		await withClient(async (client) => {
			await client.modify(user.dn, [
				new Change({
					operation: 'add',
					modification: new Attribute({ type: 'sshPublicKey', values: [data.key] }),
				}),
			]);
		});
		result = true;
	} catch(e) {
		if (e.name === 'TypeOrValueExistsError') {
			result = 'Key already added';
		} else {
			throw e;
		}
	}
	if (result === true) cache.clear();
	return result;
};

// Every user gets a personal Unix group of the same name at creation (see
// addPosixGroup) -- just a GID holder, cn always equal to the user's uid.
// memberUid (RFC 2307, posixGroup) is a bare username, not a DN, unlike
// groupOfNames' `member` used by app_sso_* groups in group_ldap.js.
function personalGroupDN(uid){
	return `cn=${escapeLDAPDNValue(uid)},${conf.groupBase}`;
}

User.getPersonalGroupMembers = async function(uid) {
	try {
		return await withClient(async (client) => {
			const res = await client.search(personalGroupDN(uid), {
				scope: 'base',
				filter: '(objectClass=posixGroup)',
				attributes: ['memberUid'],
			});
			const entry = res.searchEntries[0];
			return [].concat((entry && entry.memberUid) || []).filter(Boolean);
		});
	} catch(error) {
		throw error;
	}
};

User.addPersonalGroupMember = async function(uid, memberUid) {
	await this.get(memberUid); // throws UserNotFound if the target uid doesn't exist
	await withClient(async (client) => {
		await client.modify(personalGroupDN(uid), [
			new Change({
				operation: 'add',
				modification: new Attribute({ type: 'memberUid', values: [memberUid] }),
			}),
		]);
	});
};

User.removePersonalGroupMember = async function(uid, memberUid) {
	await withClient(async (client) => {
		await client.modify(personalGroupDN(uid), [
			new Change({
				operation: 'delete',
				modification: new Attribute({ type: 'memberUid', values: [memberUid] }),
			}),
		]);
	});
};

User.invite = async function(data = {}){
	try{
		let token = await InviteToken.create({
			created_by: this.uid,
			groups: JSON.stringify([].concat(data.groups || [])),
		});

		if (data.mail) {
			await User.verifyEmail({ token: token.token, mail: data.mail, url: data.url });
			return InviteToken.get(token.token);
		}

		return token;
	}catch(error){
		throw error;
	}
};

User.login = async function(data){
	try{
		let user = await this.get(data.uid || data.username);

		const loginClient = makeClient();
		try {
			await loginClient.bind(user.dn, data.password);
		} finally {
			await loginClient.unbind().catch(() => {});
		}

		return user;

	}catch(error){
		console.error("USER LOGIN error:", error.name, error.message);
		throw error;
	}
};


module.exports = {User, hashPasswordSSHA512, nextPosixId};


// (async function(){
// try{
// 	console.log(await User.list());

// 	console.log(await User.listDetail());

// 	console.log(await User.get('wmantly'))

// }catch(error){
// 	console.error(error)
// }
// })()