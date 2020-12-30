'use strict';

const { Client, Attribute, Change } = require('ldapts');
const crypto = require('crypto');

const {Mail} = require('./email');
const {Token, InviteToken, PasswordResetToken} = require('./token');
const conf = require('../app').conf.ldap;

const client = new Client({
  url: conf.url,
});

async function addPosixGroup(client, data){

  try{
	const groups = (await client.search(conf.groupBase, {
	  scope: 'sub',
	  filter: '(&(objectClass=posixGroup))',
	})).searchEntries;

	data.gidNumber = (Math.max(...groups.map(i => i.gidNumber))+1)+'';

	await client.add(`cn=${data.cn},${conf.groupBase}`, {
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

	data.uidNumber = (Math.max(...people.map(i => i.uidNumber))+1)+'';

	await client.add(`cn=${data.cn},${conf.userBase}`, {
		cn: data.cn,
		sn: data.sn,
		uid: data.uid,
		uidNumber: data.uidNumber,
		gidNumber: data.gidNumber,
		givenName: data.givenName,
		mail: data.mail,
		mobile: data.mobile,
		loginShell: data.loginShell,
		homeDirectory: data.homeDirectory,
		userPassword: data.userPassword,
		description: data.description || ' ', 
		sudoHost: 'ALL',
		sudoCommand: 'ALL',
		sudoUser: data.uid,
		sshPublicKey: data.sshPublicKey,
		objectclass: ['inetOrgPerson', 'sudoRole', 'ldapPublicKey', 'posixAccount', 'top' ]
	});

	return data

  }catch(error){
	throw error;
  }

}

async function addLdapUser(client, data){

	var group;

  try{
	data.uid = `${data.givenName[0]}${data.sn}`.toLowerCase();
	data.cn = data.uid;
	data.loginShell = '/bin/bash';
	data.homeDirectory= `/home/${data.uid}`;
	data.userPassword = '{MD5}'+crypto.createHash('md5').update(data.userPassword, "binary").digest('base64');

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
		await client.del(data.dn);
	}catch(error){
		throw error;
	}
}

async function deleteLdapDN(client, dn, ignoreError){
	try{
		client.del(dn)
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

	return data;
}

var User = {}

User.backing = "LDAP";

User.list = async function(){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		const res = await client.search(conf.userBase, {
		  scope: 'sub',
		  filter: conf.userFilter,
		  attributes: ['*', 'createTimestamp', 'modifyTimestamp'],
		});

		await client.unbind();

		return res.searchEntries.map(function(user){return user.uid});
	}catch(error){
		throw error;
	}
};

User.listDetail = async function(){
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		const res = await client.search(conf.userBase, {
		  scope: 'sub',
		  filter: conf.userFilter,
		  attributes: ['*', 'createTimestamp', 'modifyTimestamp'],
		});

		await client.unbind();

		let users = []

		for(let user of res.searchEntries){
			let obj = Object.create(this);
			Object.assign(obj, user_parse(user));
			
			users.push(obj)

		}

		return users;

	}catch(error){
		throw error;
	}
};

User.get = async function(data, key){
	try{
		if(typeof data !== 'object'){
			let uid = data;
			data = {};
			data.uid = uid;
		}


		await client.bind(conf.bindDN, conf.bindPassword);

		data.searchKey = data.searchKey || key || conf.userNameAttribute;
		data.searchValue = data.searchValue || data.uid;

		let filter = `(&${conf.userFilter}(${data.searchKey}=${data.searchValue}))`;

		const res = await client.search(conf.userBase, {
			scope: 'sub',
			filter: filter,
			attributes: ['*', 'createTimestamp', 'modifyTimestamp'],
		});

		await client.unbind();

		let user = res.searchEntries[0]

		if(user){
			let obj = Object.create(this);
			Object.assign(obj, user_parse(user));
			
			return obj;
		}else{
			let error = new Error('UserNotFound');
			error.name = 'UserNotFound';
			error.message = `LDAP:${data.searchValue} does not exists`;
			error.status = 404;
			throw error;
		}
	}catch(error){
		throw error;
	}
};

User.exists = async function(data, key){
	// Return true or false if the requested entry exists ignoring error's.
	try{
		await this.get(data, key);

		return true
	}catch(error){
		return false;
	}
};

User.add = async function(data) {
	try{
		await client.bind(conf.bindDN, conf.bindPassword);

		await addLdapUser(client, data);

		await client.unbind();

		let user = await this.get(data.uid);


		await Mail.sendTemplate(
			user.mail,
			'welcome',
			{
				user: user
			}
		)

		return user;

	}catch(error){
		if(error.message.includes('exists')){
			let error = new Error('UserNameUsed');
			error.name = 'UserNameUsed';
			error.message = `LDAP:${data.uid} already exists`;
			error.status = 409;

			throw error;
		}
		throw error;
	}
};

User.update = async function(data){
	try{
		let editableFeilds = ['mobile', 'sshPublicKey', 'description'];

		await client.bind(conf.bindDN, conf.bindPassword);

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
			}
		}

		await client.unbind()

		return this;

	}catch(error){
		throw error;
	}
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

		let user = await this.add(data);

		if(user){
			await token.consume({claimed_by: user.uid});
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
		await token.update({mail: data.mail})

		console.log(`email link ${data.url}/login/invite/${token.token}/${token.mail_token}`)

		await Mail.sendTemplate(
			data.mail,
			'validate_link',
			{
				link:`${data.url}/login/invite/${token.token}/${token.mail_token}`
			}
		)

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

		let token = await PasswordResetToken.add(user);

		await Mail.sendTemplate(
			user.mail,
			'reset_link',
			{
				user: user,
				link:`${url}/login/resetpassword/${token.token}`
			}
		)

		return true;
	}catch(error){
		// if(error.name === 'UserNotFound') return false;
		throw error;
	}
};


User.remove = async function(data){
	try{

		await client.bind(conf.bindDN, conf.bindPassword);

		await deleteLdapUser(client, this);

		await client.unbind();

		return true;

	}catch(error){
		throw error;
	}
};

User.setPassword = async function(data){
	try{

		await client.bind(conf.bindDN, conf.bindPassword);

		await client.modify(this.dn, [
		  new Change({
			operation: 'replace',
			modification: new Attribute({
			  type: 'userPassword',
			  values: ['{MD5}'+crypto.createHash('md5').update(data.userPassword, "binary").digest('base64')] 
			})}),
		]); 

		await client.unbind();

		return this;
	}catch(error){
		throw error;
	}
};

User.invite = async function(){
	try{
		let token = await InviteToken.add({created_by: this.uid});
		
		return token;

	}catch(error){
		throw error;
	}
};

User.login = async function(data){
	try{
		let user = await this.get(data.uid);

		await client.bind(user.dn, data.password);

		await client.unbind();

		return user;

	}catch(error){
		throw error;
	}
};


module.exports = {User};


// (async function(){
// try{
// 	console.log(await User.list());

// 	console.log(await User.listDetail());

// 	console.log(await User.get('wmantly'))

// }catch(error){
// 	console.error(error)
// }
// })()