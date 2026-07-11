'use strict';

// Base configuration — generic defaults usable by anyone.
//
// These are NON-secret defaults. Per-deployment values (LDAP bind DN, user/group
// bases, SMTP host/user, OAuth issuer, sender address) should be overridden via
// conf/secrets.js or `app_*` environment variables (see @simpleworkjs/conf).
// Secret values (passwords, JWT secret, API keys) MUST come from secrets.js or
// `app_*` env vars — never commit them here.
module.exports = {
	name: "SSO Manager", // displayed in the UI and outbound email
	userModel: 'ldap', // pam, redis, ldap
	redis: {
		prefix: 'sso_manager_'
	},
	ldap: {
		url: 'ldap://localhost',
		bindDN: 'cn=admin,dc=example,dc=com',
		bindPassword: '__in secrets file__',
		userBase: 'ou=people,dc=example,dc=com',
		groupBase: 'ou=groups,dc=example,dc=com',
		userFilter: '(objectClass=posixAccount)',
		userNameAttribute: 'uid'
	},
	oauth: {
		issuer: '', // falls back to the request host at runtime (routes/index.js)
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
		host: 'localhost',
		port: 587,
		secure: false,
		user: 'noreply@example.com',
		pass: '__in secrets file__',
		from: 'SSO Manager <noreply@example.com>',
	},
};