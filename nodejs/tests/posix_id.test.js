'use strict';

const { nextPosixId } = require('../models/user_ldap');

// Pure logic, no LDAP/Redis needed -- regression coverage for the bug where
// an empty directory (Math.max() on an empty array is -Infinity in JS, not
// 0) produced an invalid "-Infinity" uid/gidNumber and every user creation
// failed with InvalidSyntaxError. Uses the real conf/base.js defaults
// (uidGidMin: 1500, uidGidReservedFloor: 9000).
describe('nextPosixId', () => {
	test('starts at uidGidMin (1500) when there are no existing entries', () => {
		expect(nextPosixId([], 'uidNumber')).toBe('1500');
	});

	test('continues from the highest existing value below the reserved floor', () => {
		const entries = [{ uidNumber: '1500' }, { uidNumber: '1501' }];
		expect(nextPosixId(entries, 'uidNumber')).toBe('1502');
	});

	test('ignores entries at/above uidGidReservedFloor (e.g. the bootstrap admin at 10000)', () => {
		const entries = [{ uidNumber: '10000' }];
		expect(nextPosixId(entries, 'uidNumber')).toBe('1500');
	});

	test('a reserved high entry does not affect allocation once real users exist', () => {
		const entries = [{ uidNumber: '10000' }, { uidNumber: '1500' }, { uidNumber: '1501' }];
		expect(nextPosixId(entries, 'uidNumber')).toBe('1502');
	});

	test('ignores non-numeric/missing values instead of producing NaN', () => {
		const entries = [{ uidNumber: undefined }, { someOtherField: '1' }];
		expect(nextPosixId(entries, 'uidNumber')).toBe('1500');
	});

	test('works the same way for gidNumber', () => {
		expect(nextPosixId([], 'gidNumber')).toBe('1500');
		expect(nextPosixId([{ gidNumber: '1500' }], 'gidNumber')).toBe('1501');
	});
});
