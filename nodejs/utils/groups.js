'use strict';

// Theta42 group & permission model.
//
// Canonical spec: theta-suite/docs/GROUPS.md. Group names follow a fixed,
// parseable structure. The structural delimiter is `_`; site/host/app slugs
// never contain it. Aggregates use the plural kind (hosts/apps); per-resource
// uses the singular (host/app).
//
//   god_admin                              global — everything, everywhere
//   {site}_super_admin                     everything on the site
//   {site}_hosts_<level>                   admin/access/capability on ALL hosts at the site
//   {site}_hosts_<level>
//   {site}_host_<slug>_<level>             admin/access/capability on ONE host
//   {site}_apps_<level>                    ... on ALL apps at the site
//   {site}_app_<slug>_<level>              ... on ONE app
//   {site}_everyone / everyone             meta groups (implicit membership)
//
// `level` is 'admin', 'access', or an opaque `<capability>`. `admin` implies
// `access`; capabilities are explicit and never implied by `admin`. Groups are
// `groupOfNames` (RBAC) — no gidNumber; hosts map GIDs on the fly (SSSD).
//
// This module is pure logic (no LDAP/DB) so it is fully unit-testable. Callers
// supply the user's group memberships (e.g. from Group.list(user.dn)).

const GOD_ADMIN = 'god_admin';
const KNOWN_LEVELS = ['admin', 'access'];
const KINDS = ['host', 'app'];

// Normalize a site/host/app slug: lowercase; runs of non-alnum -> '-'; never
// contains '_' (the structural delimiter), so group names parse unambiguously.
function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Validate a kind (host/app) — throw on anything else.
function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`invalid resource kind: ${kind} (must be host or app)`);
}

// {site}_host_<slug>_<level> / {site}_app_<slug>_<level>
function resourceGroupCns(site, kind, slug, level) {
  assertKind(kind);
  return `${slugify(site)}_${kind}_${slugify(slug)}_${level}`;
}

// {site}_hosts_<level> / {site}_apps_<level> (plural kind — the aggregate).
function aggregateGroupCns(site, kind, level) {
  assertKind(kind);
  return `${slugify(site)}_${kind}s_${level}`;
}

// {site}_super_admin
function siteSuperAdminCns(site) {
  return `${slugify(site)}_super_admin`;
}

// {site}_everyone
function siteEveryoneCns(site) {
  return `${slugify(site)}_everyone`;
}

// True if `level` is a known admin/access level (not an opaque capability).
function isKnownLevel(level) {
  return KNOWN_LEVELS.includes(level);
}

// True if holding `level` grants `wanted` (admin implies access).
function levelGrants(level, wanted) {
  if (level === wanted) return true;
  return level === 'admin' && wanted === 'access';
}

// Resolve whether a user (given `memberOf` — the group cns they belong to) has
// `level` on a resource. Applies the inheritance lattice:
//   god_admin ⊇ {site}_super_admin ⊇ aggregate ⊇ specific; admin ⊇ access.
//
//   memberOf: array of group cns the user is a member of.
//   resource: { site, kind: 'host'|'app', slug }.
//   level:    'admin' | 'access' | an opaque capability token.
//
// Meta-group grants (`everyone` / `{site}_everyone`) are NOT handled here — they
// are resource-level grants, resolved by the caller against the resource's own
// granted groups (see permission.onResource). This keeps the function pure over
// the user's membership only.
function hasPermission(memberOf, resource, level) {
  const site = slugify(resource && resource.site);
  const kind = resource && resource.kind;
  const slug = slugify(resource && resource.slug);
  const set = new Set(memberOf || []);

  if (set.has(GOD_ADMIN)) return true;
  if (set.has(siteSuperAdminCns(site))) return true;

  if (isKnownLevel(level)) {
    // admin / access
    if (set.has(aggregateGroupCns(site, kind, level))) return true;
    if (set.has(resourceGroupCns(site, kind, slug, level))) return true;
    if (level === 'access' && hasPermission(memberOf, resource, 'admin')) return true;
    return false;
  }
  // Opaque capability — exact aggregate or specific grant only.
  if (set.has(aggregateGroupCns(site, kind, level))) return true;
  if (set.has(resourceGroupCns(site, kind, slug, level))) return true;
  return false;
}

module.exports = {
  GOD_ADMIN,
  KNOWN_LEVELS,
  KINDS,
  slugify,
  resourceGroupCns,
  aggregateGroupCns,
  siteSuperAdminCns,
  siteEveryoneCns,
  isKnownLevel,
  levelGrants,
  hasPermission,
};
