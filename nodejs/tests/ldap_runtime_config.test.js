'use strict';

// The delta logic behind live replication config. The end-to-end proof that
// slapd actually accepts these modifications lives in the multisite e2e
// (which reads the running cn=config back over ldapsearch); this pins the
// pure parts, which are where a silent mistake would hide.

const {
	providersByRid, ridFor, syncreplValue
} = require('../utils/ldap_runtime_config');

describe('ldap_runtime_config', () => {
	test('rid is derived from the peer ServerID, so it is stable across re-applies', () => {
		expect(ridFor(1)).toBe(101);
		expect(ridFor(7)).toBe(107);
		// Same input, same rid -- a re-apply must never renumber an existing peer.
		expect(ridFor(7)).toBe(ridFor(7));
	});

	test('providersByRid parses what slapd actually stores', () => {
		// slapd normalizes and reorders what it was given, so the delta is
		// computed from rid -> provider identity, never string equality.
		const stored = [
			'{101}rid=101 provider=ldaps://site-a:636 bindmethod=simple searchbase="dc=e2e,dc=test" type=refreshAndPersist',
			'{102}rid=102 provider="ldaps://site-b:636" type=refreshAndPersist'
		];
		const map = providersByRid(stored);
		expect(map.get(101)).toBe('ldaps://site-a:636');
		// Quoted values are unwrapped, or a re-apply would see a spurious change.
		expect(map.get(102)).toBe('ldaps://site-b:636');
		expect(map.size).toBe(2);
	});

	test('providersByRid ignores values it cannot identify', () => {
		expect(providersByRid(['garbage', 'rid=onlyrid', '']).size).toBe(0);
	});

	test('syncreplValue carries everything slapd needs to actually replicate', () => {
		const v = syncreplValue({
			rid: 102, provider: 'ldaps://site-b:636', baseDn: 'dc=e2e,dc=test',
			bindDn: 'cn=admin,dc=e2e,dc=test', cred: 'secret'
		});
		// No {n} prefix -- that ordering position is slapd's to assign.
		expect(v).toMatch(/^rid=102 /);
		expect(v).not.toMatch(/^\{/);
		expect(v).toContain('provider=ldaps://site-b:636');
		expect(v).toContain('type=refreshAndPersist');
		expect(v).toContain('searchbase="dc=e2e,dc=test"');
		expect(v).toContain('binddn="cn=admin,dc=e2e,dc=test"');
		// retry is what makes a peer that is down rejoin on its own rather
		// than staying dead until a restart.
		expect(v).toContain('retry="60 +"');
		expect(v).toContain('tls_reqcert=never');
	});

	// A value written by syncreplValue must round-trip through the parser, or
	// every apply would look like a change and churn slapd forever.
	test('a written value parses back to the same rid and provider', () => {
		const v = syncreplValue({
			rid: ridFor(3), provider: 'ldaps://site-c:636', baseDn: 'dc=e2e,dc=test',
			bindDn: 'cn=admin,dc=e2e,dc=test', cred: 'secret'
		});
		const map = providersByRid([v]);
		expect(map.get(103)).toBe('ldaps://site-c:636');
	});
});
