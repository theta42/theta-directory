'use strict';

const {
	slugify,
	resourceGroupCns,
	aggregateGroupCns,
	siteSuperAdminCns,
	siteEveryoneCns,
	isKnownLevel,
	levelGrants,
	hasPermission,
	GOD_ADMIN,
} = require('../utils/groups');

const HOST = { site: 'Main Office', kind: 'host', slug: 'Web 01' };
const APP = { site: 'main-office', kind: 'app', slug: 'emby' };
const OTHER_SITE_HOST = { site: 'branch-office', kind: 'host', slug: 'db' };

describe('slugify', () => {
	test('lowercases, spaces and underscores become hyphens, no leading/trailing dash', () => {
		expect(slugify('Web 01')).toBe('web-01');
		expect(slugify('Main Office')).toBe('main-office');
		expect(slugify('my_host')).toBe('my-host');
		expect(slugify('  Mixed CASE--name  ')).toBe('mixed-case-name');
		expect(slugify('')).toBe('');
	});
	test('never contains an underscore (the structural delimiter)', () => {
		expect(slugify('a_b_c')).not.toContain('_');
		expect(resourceGroupCns('Main Office', 'host', 'Web 01', 'access')).not.toContain('__');
	});
});

describe('group cn builders', () => {
	test('per-resource uses singular kind', () => {
		expect(resourceGroupCns('main-office', 'host', 'web-01', 'admin')).toBe('main-office_host_web-01_admin');
		expect(resourceGroupCns('main-office', 'app', 'emby', 'access')).toBe('main-office_app_emby_access');
	});
	test('aggregate uses plural kind', () => {
		expect(aggregateGroupCns('main-office', 'host', 'admin')).toBe('main-office_hosts_admin');
		expect(aggregateGroupCns('main-office', 'app', 'access')).toBe('main-office_apps_access');
	});
	test('site super admin + everyone', () => {
		expect(siteSuperAdminCns('Main Office')).toBe('main-office_super_admin');
		expect(siteEveryoneCns('main-office')).toBe('main-office_everyone');
	});
	test('invalid kind throws', () => {
		expect(() => resourceGroupCns('s', 'service', 'x', 'admin')).toThrow();
	});
});

describe('levels', () => {
	test('admin/access known; capabilities opaque', () => {
		expect(isKnownLevel('admin')).toBe(true);
		expect(isKnownLevel('access')).toBe(true);
		expect(isKnownLevel('reboot')).toBe(false);
		expect(isKnownLevel('emby_admin')).toBe(false);
	});
	test('admin implies access; access does not imply admin', () => {
		expect(levelGrants('admin', 'access')).toBe(true);
		expect(levelGrants('access', 'admin')).toBe(false);
	});
});

describe('hasPermission — inheritance', () => {
	test('god_admin grants everything everywhere', () => {
		expect(hasPermission([GOD_ADMIN], HOST, 'admin')).toBe(true);
		expect(hasPermission([GOD_ADMIN], HOST, 'access')).toBe(true);
		expect(hasPermission([GOD_ADMIN], HOST, 'reboot')).toBe(true);
		expect(hasPermission([GOD_ADMIN], OTHER_SITE_HOST, 'admin')).toBe(true);
	});

	test('site super admin grants everything on its site, not other sites', () => {
		expect(hasPermission(['main-office_super_admin'], HOST, 'admin')).toBe(true);
		expect(hasPermission(['main-office_super_admin'], HOST, 'reboot')).toBe(true);
		expect(hasPermission(['main-office_super_admin'], OTHER_SITE_HOST, 'admin')).toBe(false);
	});

	test('aggregate (all hosts) grants on any host at the site', () => {
		expect(hasPermission(['main-office_hosts_admin'], HOST, 'admin')).toBe(true);
		expect(hasPermission(['main-office_hosts_access'], HOST, 'access')).toBe(true);
		expect(hasPermission(['main-office_hosts_admin'], HOST, 'access')).toBe(true);
	});

	test('specific host group grants only that host', () => {
		const cn = resourceGroupCns('main-office', 'host', 'web-01', 'admin');
		expect(hasPermission([cn], HOST, 'admin')).toBe(true);
		expect(hasPermission([cn], OTHER_SITE_HOST, 'admin')).toBe(false);
	});

	test('admin implies access; access does not imply admin', () => {
		expect(hasPermission([resourceGroupCns('main-office', 'host', 'web-01', 'admin')], HOST, 'access')).toBe(true);
		expect(hasPermission([resourceGroupCns('main-office', 'host', 'web-01', 'access')], HOST, 'admin')).toBe(false);
	});

	test('capabilities are exact — admin does not grant a capability', () => {
		expect(hasPermission([resourceGroupCns('main-office', 'host', 'web-01', 'reboot')], HOST, 'reboot')).toBe(true);
		expect(hasPermission([resourceGroupCns('main-office', 'host', 'web-01', 'admin')], HOST, 'reboot')).toBe(false);
		// aggregate capability
		expect(hasPermission(['main-office_hosts_reboot'], HOST, 'reboot')).toBe(true);
	});

	test('hosts and apps are orthogonal namespaces', () => {
		const hostAdmin = resourceGroupCns('main-office', 'host', 'web-01', 'admin');
		expect(hasPermission([hostAdmin], APP, 'access')).toBe(false);
		const appAdmin = resourceGroupCns('main-office', 'app', 'emby', 'admin');
		expect(hasPermission([appAdmin], APP, 'access')).toBe(true);
	});

	test('cross-site isolation', () => {
		const mainHostAdmin = resourceGroupCns('main-office', 'host', 'web-01', 'admin');
		expect(hasPermission([mainHostAdmin], OTHER_SITE_HOST, 'access')).toBe(false);
		expect(hasPermission(['branch-office_hosts_admin'], OTHER_SITE_HOST, 'admin')).toBe(true);
	});
});
