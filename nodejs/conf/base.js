'use strict';

module.exports = {
	name: "Theta42 SSO",
	userModel: 'ldap', // pam, redis, ldap
	redis: {
		prefix: 'sso_manager_'
	},
	ldap: {
		url: 'ldaps://ldap.internal.theta42.com:636',
		bindDN: 'cn=admin,dc=theta42,dc=com',
		bindPassword: '__IN SRECREST FILE__',
		userBase: 'ou=people,dc=theta42,dc=com',
		groupBase: 'ou=groups,dc=theta42,dc=com',		
		userFilter: '(objectClass=posixAccount)',
		userNameAttribute: 'uid'
	},
	oauth: {
		issuer: 'https://sso.theta42.com',
		jwtSecret: '__in secrets file__',
		token_lifetime: {
			access_token: 3600,     // 1 hour (seconds)
			refresh_token: 2592000  // 30 days (seconds)
		}
	},
	voipms: {
		username: '__in secrets file__',
		password: '__in secrets file__',
		did:      '__in secrets file__',
	},
	smtp: {
		host: 'mail.wgnode.com',
		port: 587,
		secure: false,
		user: 'noreply@users.theta42.com',
		pass: '__in secrets file__',
		from: 'Theta42 Accounts <noreply@users.theta42.com>',
	},
};
