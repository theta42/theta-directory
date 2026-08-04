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

// Resource fixtures mirror the directory's real slugs: hosts carry a `host_`
// prefix, services/apps are stored bare. The group-model builders use these
// verbatim (no re-slugifying, no kind insertion) -- see groups.js.
const HOST = { site: 'main-office', kind: 'host', slug: 'host_web-01' };
const APP = { site: 'main-office', kind: 'app', slug: 'emby' };
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
	test('per-resource uses the resource slug verbatim (kind is carried in the slug)', () => {
		expect(resourceGroupCns('main-office', 'host_web-01', 'admin')).toBe('main-office_host_web-01_admin');
		expect(resourceGroupCns('main-office', 'emby', 'access')).toBe('main-office_emby_access');
	});
	test('aggregate uses the plural kind', () => {
		expect(aggregateGroupCns('main-office', 'host', 'admin')).toBe('main-office_hosts_admin');
		expect(aggregateGroupCns('main-office', 'app', 'access')).toBe('main-office_apps_access');
	});
	test('site super admin + everyone', () => {
		expect(siteSuperAdminCns('main-office')).toBe('main-office_super_admin');
		expect(siteEveryoneCns('main-office')).toBe('main-office_everyone');
	});
	test('a directory site slug with a kind prefix is kept verbatim, not re-slugified', () => {
		// Resource slugs are `site_local` / `host_theta-env` -- re-slugifying the
		// site (`site_local` -> `site-local`) would corrupt the delimiter.
		expect(siteSuperAdminCns('site_local')).toBe('site_local_super_admin');
		expect(siteEveryoneCns('site_local')).toBe('site_local_everyone');
		expect(aggregateGroupCns('site_local', 'host', 'admin')).toBe('site_local_hosts_admin');
		expect(resourceGroupCns('site_local', 'host_theta-env', 'access')).toBe('site_local_host_theta-env_access');
	});
	test('invalid kind throws (aggregates only — per-resource has no kind arg)', () => {
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
		const cn = resourceGroupCns('main-office', 'host_web-01', 'admin');
		expect(hasPermission([cn], HOST, 'admin')).toBe(true);
		expect(hasPermission([cn], OTHER_SITE_HOST, 'admin')).toBe(false);
	});

	test('admin implies access; access does not imply admin', () => {
		expect(hasPermission([resourceGroupCns('main-office', 'host_web-01', 'admin')], HOST, 'access')).toBe(true);
		expect(hasPermission([resourceGroupCns('main-office', 'host_web-01', 'access')], HOST, 'admin')).toBe(false);
	});

	test('capabilities are exact — admin does not grant a capability', () => {
		expect(hasPermission([resourceGroupCns('main-office', 'host_web-01', 'reboot')], HOST, 'reboot')).toBe(true);
		expect(hasPermission([resourceGroupCns('main-office', 'host_web-01', 'admin')], HOST, 'reboot')).toBe(false);
		// aggregate capability
		expect(hasPermission(['main-office_hosts_reboot'], HOST, 'reboot')).toBe(true);
	});

	test('hosts and apps are orthogonal namespaces', () => {
		const hostAdmin = resourceGroupCns('main-office', 'host_web-01', 'admin');
		expect(hasPermission([hostAdmin], APP, 'access')).toBe(false);
		const appAdmin = resourceGroupCns('main-office', 'emby', 'admin');
		expect(hasPermission([appAdmin], APP, 'access')).toBe(true);
	});

	test('cross-site isolation', () => {
		const mainHostAdmin = resourceGroupCns('main-office', 'host_web-01', 'admin');
		expect(hasPermission([mainHostAdmin], OTHER_SITE_HOST, 'access')).toBe(false);
		expect(hasPermission(['branch-office_hosts_admin'], OTHER_SITE_HOST, 'admin')).toBe(true);
	});
});
