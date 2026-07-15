'use strict';

const { redirectUriAllowed } = require('../routes/oauth');

// Pure logic, no LDAP/Redis needed -- regression coverage for the bug where
// theta42/proxy's per-host SSO callback (a different URL per proxied host,
// e.g. https://site.example.com/__proxy_auth/callback) could never match a
// single OAuth client's redirect_uris list without registering every host's
// callback individually. `*`/`**` wildcard support lets one registered
// pattern (e.g. https://*.example.com/__proxy_auth/callback) cover a whole
// domain's worth of proxied hosts.
describe('redirectUriAllowed', () => {
	test('exact match still works with no wildcard present', () => {
		expect(redirectUriAllowed(
			['https://app.example.com/cb'],
			'https://app.example.com/cb'
		)).toBe(true);
	});

	test('rejects a uri that is not registered', () => {
		expect(redirectUriAllowed(
			['https://app.example.com/cb'],
			'https://app.example.com/cb2'
		)).toBe(false);
	});

	test('* matches exactly one hostname label', () => {
		expect(redirectUriAllowed(
			['https://*.example.com/__proxy_auth/callback'],
			'https://site.example.com/__proxy_auth/callback'
		)).toBe(true);
	});

	test('* does not span multiple labels', () => {
		expect(redirectUriAllowed(
			['https://*.example.com/__proxy_auth/callback'],
			'https://site.nl.example.com/__proxy_auth/callback'
		)).toBe(false);
	});

	test('** spans multiple labels', () => {
		expect(redirectUriAllowed(
			['https://**.example.com/__proxy_auth/callback'],
			'https://site.nl.example.com/__proxy_auth/callback'
		)).toBe(true);
	});

	test('scheme mismatch is not allowed even with a wildcard', () => {
		expect(redirectUriAllowed(
			['https://*.example.com/__proxy_auth/callback'],
			'http://site.example.com/__proxy_auth/callback'
		)).toBe(false);
	});

	test('a wildcard pattern does not match an unrelated domain', () => {
		expect(redirectUriAllowed(
			['https://**.example.com/__proxy_auth/callback'],
			'https://evil.com/__proxy_auth/callback'
		)).toBe(false);
	});

	test('empty/missing patterns list rejects everything', () => {
		expect(redirectUriAllowed([], 'https://app.example.com/cb')).toBe(false);
		expect(redirectUriAllowed(undefined, 'https://app.example.com/cb')).toBe(false);
	});
});
