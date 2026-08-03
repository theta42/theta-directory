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
	logo: "/static/img/theta42.svg", // shown in the nav/footer; point at your own file under public/ (or an absolute URL) to white-label
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
		userNameAttribute: 'uid',
		// Hostname/port advertised on the /integrations page for direct-LDAP
		// clients. Leave ldapsHost empty to derive it from the OAuth issuer host.
		// Set it to an internal-only name (e.g. 'ldap.internal.example.com' or
		// 'sso-manager' on the Docker network) so external clients don't need a
		// public 636 port forward. See docs/ldap.md.
		ldapsHost: '',
		ldapsPort: 636,
		// True when slapd carries the `nestgroup` overlay, which resolves nested
		// groups server-side. Set automatically by docker-entrypoint.sh for the
		// all-in-one image; leave false when pointing at a stock OpenLDAP (no
		// 2.6.x release ships nestgroup) and the app resolves nesting itself.
		nestedGroupsServerSide: false,
		// New users/personal groups (see addPosixAccount/addPosixGroup in
		// models/user_ldap.js) get the next uid/gidNumber >= uidGidMin.
		// Existing entries >= uidGidReservedFloor are ignored when computing
		// that "next available" number, so a deliberately high, easily
		// recognizable id (e.g. the bootstrap admin at 10000 — see
		// theta-env's bootstrap.js) doesn't drag every real user's id up
		// into that same range.
		uidGidMin: 1500,
		uidGidReservedFloor: 9000,
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
	directory: {
		// Public SSH jump host fronting the lab, if there is one (the jump-host
		// component). When set, a host card in the catalog shows the real
		// invocation — `ssh <uid>_-_<slug>@<jumpHost>` — instead of a bare
		// `ssh <uid>@<ip>` that only works from inside the LAN. Empty is fine;
		// the card falls back to the direct form.
		jumpHost: '',
		// Default SSH port assumed when a host carries no metadata.sshPort.
		defaultSshPort: 22,
	},
	service: {
		updateCheck: {
			enabled: true,
			initial: 30000,      // first check 30s after start
			interval: 86400000,  // then every 24h
		},
	},
};