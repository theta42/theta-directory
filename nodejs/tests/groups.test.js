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

// Resource fixtures mirror the directory: hosts carry a `host_` prefix, services
// are stored bare. The builders take the *name* slug (kind stripped) + a kind, so
// a host `host_web-01` gives `main-office_host_web-01_*` and a service `emby`
// gives `main-office_app_emby_*` -- matching docs/GROUPS.md §2.
const HOST = { site: 'main-office', kind: 'host', slug: 'host_web-01' };
const APP = { site: 'main-office', kind: 'app', slug: 'emby' };
const SERVICE = { site: 'main-office', kind: 'service', slug: 'emby' };
const OTHER_SITE_HOST = { site: 'branch-office', kind: 'host', slug: 'host_db' };

describe('slugify', () => {
	test('lowercases, spaces and underscores become hyphens, no leading/trailing dash', () => {
		expect(slugify('Web 01')).toBe('web-01');
		expect(slugify('Main Office')).toBe('main-office');
		expect(slugify('my_host')).toBe('my-host');
		expect(slugify('  Mixed CASE--name  ')).toBe('mixed-case-name');
		expect(slugify('')).toBe('');
	});
});

describe('group cn builders', () => {
	test('per-resource names the kind + name slug (docs §2)', () => {
		expect(resourceGroupCns('main-office', 'host', 'web-01', 'admin')).toBe('main-office_host_web-01_admin');
		expect(resourceGroupCns('main-office', 'app', 'emby', 'access')).toBe('main-office_app_emby_access');
	});
	test('a prefixed site slug is kept verbatim; the resource name slug is kind-stripped', () => {
		expect(resourceGroupCns('site_local', 'host', 'theta-env', 'access')).toBe('site_local_host_theta-env_access');
		expect(resourceGroupCns('site_local', 'app', 'sso-manager', 'access')).toBe('site_local_app_sso-manager_access');
	});
	test('aggregate uses the plural kind', () => {
		expect(aggregateGroupCns('main-office', 'host', 'admin')).toBe('main-office_hosts_admin');
		expect(aggregateGroupCns('main-office', 'app', 'access')).toBe('main-office_apps_access');
	});
	test('site super admin + everyone', () => {
		expect(siteSuperAdminCns('main-office')).toBe('main-office_super_admin');
		expect(siteEveryoneCns('main-office')).toBe('main-office_everyone');
	});
	test('a directory site slug with a kind prefix is kept verbatim', () => {
		expect(siteSuperAdminCns('site_local')).toBe('site_local_super_admin');
		expect(siteEveryoneCns('site_local')).toBe('site_local_everyone');
		expect(aggregateGroupCns('site_local', 'host', 'admin')).toBe('site_local_hosts_admin');
	});
	test('invalid kind throws', () => {
		expect(() => resourceGroupCns('s', 'service', 'x', 'admin')).toThrow();
		expect(() => aggregateGroupCns('s', 'service', 'admin')).toThrow();
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
		expect(hasPermission(['main-office_hosts_reboot'], HOST, 'reboot')).toBe(true);
	});

	test('hosts and apps are orthogonal namespaces', () => {
		const hostAdmin = resourceGroupCns('main-office', 'host', 'web-01', 'admin');
		expect(hasPermission([hostAdmin], APP, 'access')).toBe(false);
		const appAdmin = resourceGroupCns('main-office', 'app', 'emby', 'admin');
		expect(hasPermission([appAdmin], APP, 'access')).toBe(true);
	});

	test('a service maps to the app kind (docs §11)', () => {
		// The directory `service` kind is the group model's `app`.
		expect(hasPermission([resourceGroupCns('main-office', 'app', 'emby', 'admin')], SERVICE, 'admin')).toBe(true);
		expect(hasPermission([resourceGroupCns('main-office', 'host', 'web-01', 'admin')], SERVICE, 'admin')).toBe(false);
	});

	test('cross-site isolation', () => {
		const mainHostAdmin = resourceGroupCns('main-office', 'host', 'web-01', 'admin');
		expect(hasPermission([mainHostAdmin], OTHER_SITE_HOST, 'access')).toBe(false);
		expect(hasPermission(['branch-office_hosts_admin'], OTHER_SITE_HOST, 'admin')).toBe(true);
	});
});
