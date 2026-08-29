'use strict';

// Unit tests for the push-token forwarding HMAC (H-14). No LDAP required —
// this exercises the sign/verify round-trip and the replay/window checks
// directly.

const fwdAuth = require('../utils/forwarded_auth_hmac');

describe('forwarded_auth_hmac (H-14)', () => {
	const TOKEN = 'push_test_token';
	const UID = 'alice';
	const PATH = '/api/user';

	test('sign produces a hex HMAC, verify accepts it', () => {
		const ts = String(Date.now());
		const mac = fwdAuth.sign(TOKEN, UID, ts, PATH);
		expect(typeof mac).toBe('string');
		expect(mac).toMatch(/^[0-9a-f]+$/);
		expect(fwdAuth.verify(TOKEN, UID, ts, PATH, mac)).toBe(true);
	});

	test('verify rejects a wrong token', () => {
		const ts = String(Date.now());
		const mac = fwdAuth.sign(TOKEN, UID, ts, PATH);
		expect(fwdAuth.verify('wrong_token', UID, ts, PATH, mac)).toBe(false);
	});

	test('verify rejects a tampered MAC', () => {
		const ts = String(Date.now());
		const mac = fwdAuth.sign(TOKEN, UID, ts, PATH);
		const flipped = mac[0] === 'a' ? 'b' : 'a' + mac.slice(1);
		expect(fwdAuth.verify(TOKEN, UID, ts, PATH, flipped)).toBe(false);
	});

	test('verify rejects a different path', () => {
		const ts = String(Date.now());
		const mac = fwdAuth.sign(TOKEN, UID, ts, PATH);
		expect(fwdAuth.verify(TOKEN, UID, ts, '/api/other', mac)).toBe(false);
	});

	test('verify rejects a different uid', () => {
		const ts = String(Date.now());
		const mac = fwdAuth.sign(TOKEN, UID, ts, PATH);
		expect(fwdAuth.verify(TOKEN, 'bob', ts, PATH, mac)).toBe(false);
	});

	test('verify rejects a timestamp outside the ±5 min window', () => {
		const old = String(Date.now() - 6 * 60 * 1000); // 6 minutes ago
		const mac = fwdAuth.sign(TOKEN, UID, old, PATH);
		expect(fwdAuth.verify(TOKEN, UID, old, PATH, mac)).toBe(false);
	});

	test('verify rejects missing/empty arguments', () => {
		const ts = String(Date.now());
		const mac = fwdAuth.sign(TOKEN, UID, ts, PATH);
		expect(fwdAuth.verify('', UID, ts, PATH, mac)).toBe(false);
		expect(fwdAuth.verify(TOKEN, '', ts, PATH, mac)).toBe(false);
		expect(fwdAuth.verify(TOKEN, UID, '', PATH, mac)).toBe(false);
		expect(fwdAuth.verify(TOKEN, UID, ts, PATH, '')).toBe(false);
		expect(fwdAuth.verify(TOKEN, UID, 'not-a-number', PATH, mac)).toBe(false);
	});

	test('verify rejects a MAC of wrong length', () => {
		const ts = Date.now();
		expect(fwdAuth.verify(TOKEN, UID, ts, PATH, 'abcd')).toBe(false);
	});
});
