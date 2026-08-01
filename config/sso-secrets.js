'use strict';

// Local per-deployment configuration for this Theta42 instance.
// This file is gitignored — it contains real secrets and per-deployment
// values. The committed conf/base.js now ships generic defaults
// (example.com / localhost); the theta42-specific non-secret values that
// used to live in base.js have been migrated here so this instance keeps
// working. New deployments should put their own values here or in app_* env.
module.exports = {
        port: 3001,
        name: 'Theta42 SSO',
        ldap: {
                url: 'ldap://10.2.0.54',
                bindDN: 'cn=admin,dc=theta42,dc=com',
                bindPassword: 'Tomisgaypalm7',
                userBase: 'ou=people,dc=theta42,dc=com',
                groupBase: 'ou=groups,dc=theta42,dc=com',
        },
        smtp: {
                host: 'mail.wgnode.com',
                user: 'noreply@users.theta42.com',
                // user: '',
                pass: 'ZxAsQw!2',
                from: 'Theta42 Accounts <noreply@users.theta42.com>',
        },
        voipms: {
                username: 'wmantly@gmail.com',
                password: 'EMjQvAuHhD!d5dm',
                did:      '9297353350',
        },
        oauth: {
                issuer: 'https://sso.theta42.com',
                jwtSecret: '09e2501a1c93aef4d5d713c7db17c800c6d7d6f5f9e9cf2efbdfa37549021bf9',
        },
};