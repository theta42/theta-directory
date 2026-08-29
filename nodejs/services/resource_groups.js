'use strict';

// Provisioning the LDAP groups a resource gets.
//
// This lived inside routes/api_directory_admin.js, which meant the OTHER place
// that creates groups for a resource -- POST /api/discovery/promote/:slug --
// could not reach it and grew its own version. The two disagreed on
// everything that matters:
//
//   naming   `<site>_<kind>_<slug>_access`  vs a bare `<slug>_access`
//   levels   member/owner                   vs user/admin  ("user" is not a
//                                              level the access model ranks, so
//                                              a promoted resource's access
//                                              group granted nothing)
//   nesting  into the site aggregates and   vs none, so site admins did not
//            god_admin                         reach a promoted resource
//
// Which naming scheme a resource ended up with therefore depended on how it was
// created, and that is not a thing an access-control system can afford to be
// casual about. One implementation, used by both.

const { Group } = require('../models/group_ldap');
const { ResourceGroup } = require('../models/resource');
const groups = require('../utils/groups');
const permission = require('../utils/permission');
const { templateFor } = require('./subtype_templates');

const SUPER_ADMIN_GROUP = permission.SUPER_ADMIN_GROUP;

// Which group family a resource gets, or null for "no groups of its own".
//
// The subtype has the final say. Now that a container is a `service` and a BMC
// is a `host` -- rather than the made-up kinds they used to carry -- kind alone
// would mint an <slug>_access/<slug>_admin pair for every systemd unit and
// every Docker container on every machine, which is exactly the sprawl
// services/subtype_templates.js exists to prevent.
//
// templateFor().ownGroups was already the authority on this question for access
// projection. It was simply never consulted at provisioning time, so the two
// halves of the system disagreed about which resources have their own groups.
function groupKind(resource) {
  if (!resource) return null;
  if (!templateFor(resource).ownGroups) return null;
  if (resource.kind === 'host') return 'host';
  if (resource.kind === 'service') return 'app';
  return null;
}

// Make `childCn` a member of `parentCn`, i.e. everyone in the child is
// transitively in the parent. Idempotent and non-fatal: "already a member" is
// the goal state, and a missing group (e.g. god_admin absent on a
// directory seeded by an older entrypoint) is a reason to skip, not to fail the
// caller's real work.
async function nestGroup(childCn, parentCn) {
  try {
    const parent = await Group.get(parentCn);
    const child = await Group.get(childCn);
    if (await Group.wouldCycle(parentCn, child.dn)) {
      console.error(`nestGroup: refusing ${childCn} -> ${parentCn} (would create a cycle)`);
      return;
    }
    await parent.addMember({ dn: child.dn });
  } catch (err) {
    const benign = err.name === 'TypeOrValueExistsError' || err.code === 20 || err.name === 'GroupNotFound';
    if (!benign) console.error(`nestGroup: ${childCn} -> ${parentCn} failed:`, err.message);
  }
}

// ── Group-model provisioning (docs/GROUPS.md) ───────────────────────────────
// The directory is the single place groups are created, as a projection of the
// resource graph. These helpers materialize the group-inheritance lattice for
// a resource so it exists in LDAP as well as in the resolver (utils/groups.js).
// All of them are idempotent, so calling them again for a resource a newer
// release is backfilling is a no-op.

// Map a directory resource kind onto a group-model kind (GROUPS.md §2).
// host -> host; service -> app (services/consoles are the group model's "apps");
// site gets site-level groups (handled separately); container and the
// inheriting subtypes (systemd units, port forwards, oauth clients) get no
// per-resource groups -- that is decided by the subtype template's
// `inherits_host_access`, via templateFor().ownGroups below.

// Create a groupOfNames if it doesn't already exist. Idempotent; `ownerDn`
// seeds the mandatory first member. Returns true when created.
async function ensureGroup(name, ownerDn, description) {
  try {
    await Group.add({ name, owner: ownerDn, description });
    return true;
  } catch (err) {
    if (err.name !== 'EntryAlreadyExistsError' && err.code !== 68) {
      console.error(`ensureGroup: failed to create ${name}:`, err);
    }
    return false;
  }
}

// Link a group to a resource only if that link doesn't already exist. The
// ResourceGroup table has no unique constraint on (resourceId, groupCn), so a
// naive create on every Directory self-heal (which runs ensureSiteGroups /
// provisionResourceGroups on each load) was accumulating duplicate links -- the
// "groups appear 3x under a resource" bug. Always check first.
// (services/discovery_reconciler.js's autoPromote path had the same bug via
// its own raw ResourceGroup.create() -- both now share ResourceGroup.ensure().)
async function ensureResourceGroup(resourceId, groupCn, accessLevel) {
  return ResourceGroup.ensure(resourceId, groupCn, accessLevel);
}

// Provision the site-level groups + the aggregates the per-resource groups nest
// into. Idempotent -- called on every directory list so a site seeded by an
// older release gets its groups without a rebuild:
//
//   god_admin -> {site}_super_admin
//   {site}_super_admin -> {site}_hosts_admin, {site}_apps_admin
//   {site}_hosts_admin -> {site}_hosts_access ; {site}_apps_admin -> {site}_apps_access
//
// `{site}_everyone` is created for completeness; it has implicit membership and
// is granted to a resource as a grantee, never enumerated.
async function ensureSiteGroups(siteSlug, ownerDn, siteName, siteResourceId) {
  if (!siteSlug) return;

  // Link a site group to the site resource (so it shows + is member-manageable
  // on the site's modal). Idempotent. Admin groups link as owner; access/meta
  // groups as member.
  const link = async (cn, isAdmin) => {
    if (!siteResourceId) return;
    await ensureResourceGroup(siteResourceId, cn, isAdmin ? 'owner' : 'member');
  };

  const sAdmin = groups.siteSuperAdminCns(siteSlug);
  await ensureGroup(sAdmin, ownerDn, `Site admin for ${siteName || siteSlug}`);
  await link(sAdmin, true);
  // The kind-scoped aggregates are CREATED here (per-resource groups nest into
  // them), but are NOT linked to the site resource: a site carries only the god
  // and site-wide groups (S_super_admin, S_everyone), per the user's model. The
  // aggregates have no modal home; site-wide access is granted via S_super_admin
  // and per-resource access via the host/app groups.
  for (const kind of ['host', 'app']) {
    await ensureGroup(groups.aggregateGroupCns(siteSlug, kind, 'admin'), ownerDn, `Admin on all ${kind}s at ${siteSlug}`);
    await ensureGroup(groups.aggregateGroupCns(siteSlug, kind, 'access'), ownerDn, `Access to all ${kind}s at ${siteSlug}`);
  }
  await ensureGroup(groups.siteEveryoneCns(siteSlug), ownerDn, `All users at ${siteSlug}`);
  await link(groups.siteEveryoneCns(siteSlug), false);
  // god_admin is the global group; surface it on the site modal so its members
  // can be managed from the Directory (it has no home on a single resource).
  await link(groups.GOD_ADMIN, true);

  // Wire the lattice as nesting so LDAP-level consumers (SSSD, sudo, anything
  // binding directly) resolve it transitively, not just utils/permission.js.
  // nestGroup(child, parent) makes child a member of parent -- membership flows
  // child -> parent ("up"), so a group's members inherit what its parents hold.
  await nestGroup(groups.GOD_ADMIN, sAdmin); // god admins are site admins everywhere
  for (const kind of ['host', 'app']) {
    const aggAdmin = groups.aggregateGroupCns(siteSlug, kind, 'admin');
    const aggAccess = groups.aggregateGroupCns(siteSlug, kind, 'access');
    await nestGroup(sAdmin, aggAdmin);        // site admins administer all hosts/apps
    await nestGroup(aggAdmin, aggAccess);     // site admin implies site access
  }
}

// Provision the per-resource groups for a host/app and nest them into the site
// aggregates (so a site/aggregate admin reaches this resource by membership).
// Group names follow docs/GROUPS.md §2: `{site}_{kind}_{nameSlug}_{level}` where
// nameSlug is the resource name with the kind prefix stripped (`host_theta-env` ->
// `theta-env`). `kind` (host/app) both goes in the name and selects the aggregate:
//
//   {site}_{kind}_{slug}_admin  -> {site}_{kind}_{slug}_access
//   {site}_{kind}_{slug}_admin  -> {site}_{kind}s_admin    (aggregate)
//   {site}_{kind}_{slug}_access -> {site}_{kind}s_access   (aggregate)
//   god_admin                   -> {site}_{kind}_{slug}_admin  (global super admin)
async function provisionResourceGroups(resource, kind, siteSlug, ownerDn) {
  const nameSlug = groups.resourceNameSlug(resource.slug);
  const accessCn = groups.resourceGroupCns(siteSlug, kind, nameSlug, 'access');
  const adminCn = groups.resourceGroupCns(siteSlug, kind, nameSlug, 'admin');

  await ensureGroup(accessCn, ownerDn, `Access group for ${resource.name}`);
  await ensureGroup(adminCn, ownerDn, `Admin group for ${resource.name}`);

  // Link both groups to the resource so the Directory can show/revoke them.
  await ensureResourceGroup(resource.id, accessCn, 'member');
  await ensureResourceGroup(resource.id, adminCn, 'owner');

  await nestGroup(adminCn, accessCn); // administering implies using
  await nestGroup(adminCn, groups.aggregateGroupCns(siteSlug, kind, 'admin'));  // aggregate admin reaches this resource
  await nestGroup(accessCn, groups.aggregateGroupCns(siteSlug, kind, 'access')); // aggregate access reaches this resource
  await nestGroup(SUPER_ADMIN_GROUP, adminCn); // global super admin
}


module.exports = {
  groupKind,
  ensureGroup,
  ensureResourceGroup,
  nestGroup,
  ensureSiteGroups,
  provisionResourceGroups,
  SUPER_ADMIN_GROUP
};
