'use strict';
const router = require('express').Router();
const permission = require('../utils/permission');
const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { SiteJoinKey } = require('../models/site_join_key');
const { Group } = require('../models/group_ldap');
const { User } = require('../models/user_ldap');
const { cnFromDn } = require('../utils/user_groups');
const { projectResources } = require('@simpleworkjs/directory-schema');

const SUPER_ADMIN_GROUP = permission.SUPER_ADMIN_GROUP;
const groups = require('../utils/groups');
const meshReplicate = require('../utils/site_replicate');
const jumpClient = require('../utils/jump_client');

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
// site gets site-level groups (handled separately); oauth/container get no
// per-resource groups (oauth clients hang off their owning service).
function groupKind(resource) {
  if (resource.kind === 'host') return 'host';
  if (resource.kind === 'service') return 'app';
  return null;
}

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

// The group CNs it is valid to associate with a given resource (docs/GROUPS.md
// §2/§3). This is what "force the correct naming convention" means: a group
// linked to a resource must be one that parses for consumers -- the resource's
// own specific groups, its site's aggregates, site-level groups, or the global
// god_admin. Returns a Set of the fixed valid CNs plus a RegExp for opaque
// capability groups following the same shapes.
function validGroupCnsForResource(resource, siteSlug) {
  const valid = new Set();
  // A site resource only carries god_admin (added by the route) + the site-wide
  // groups (S_super_admin, S_everyone). The kind-scoped host/app aggregates and
  // specific groups belong to host/app resources, not to the site.
  if (resource.kind === 'site') {
    valid.add(groups.siteSuperAdminCns(siteSlug));
    valid.add(groups.siteEveryoneCns(siteSlug));
    return { valid, capRe: new RegExp(`^${siteSlug}_super_admin$|^${siteSlug}_everyone$`) };
  }
  const kind = groupKind(resource); // 'host'|'app'|null
  if (kind) {
    const nameSlug = groups.resourceNameSlug(resource.slug);
    valid.add(groups.resourceGroupCns(siteSlug, kind, nameSlug, 'admin'));
    valid.add(groups.resourceGroupCns(siteSlug, kind, nameSlug, 'access'));
    valid.add(groups.aggregateGroupCns(siteSlug, kind, 'admin'));
    valid.add(groups.aggregateGroupCns(siteSlug, kind, 'access'));
    valid.add(groups.siteSuperAdminCns(siteSlug));
    valid.add(groups.siteEveryoneCns(siteSlug));
    return { valid, capRe: new RegExp(`^${siteSlug}_${kind}_${nameSlug}_[a-z0-9-]+$|^${siteSlug}_${kind}s_[a-z0-9-]+$`) };
  }
  // oauth/container etc. — only the global god_admin makes sense to pin here.
  valid.add(groups.siteSuperAdminCns(siteSlug));
  return { valid, capRe: null };
}

// Require the admin group
router.use(async (req, res, next) => {
  try {
    await permission.byGroup(req.user, ['app_sso_directory_admin', 'app_sso_admin']);
    next();
  } catch(err) {
    next(err);
  }
});

// --- Resources ---
router.get('/resources', async (req, res, next) => {
  try {
    let resources = await Resource.list();
    resources = resources.filter(r => {
      // Sites are structural containers, not discovery output -- always shown.
      if (r.kind === 'site') return true;
      // A resource discovery ever touched only belongs in the Directory once
      // it's explicitly managed (created by an agent, promoted by a user, or
      // merged into an already-managed resource). Until then it's pending
      // review in the Discovered Inventory tab. Anything discovery never
      // touched (created directly through this admin UI) has no
      // discovery_sources and is always shown.
      const isDiscovered = r.metadata?.discovery_sources?.length > 0;
      const isManaged = r.metadata?.managed === true;
      return !isDiscovered || isManaged;
    });
    // Even admins never receive secret metadata (e.g. client_secret_hash) over
    // the wire; projectResources strips it unconditionally.
    //
    // Group-model self-heal (docs/GROUPS.md) used to run here, on every GET --
    // idempotent per-call, but the fan-out (ensureSiteGroups per site +
    // provisionResourceGroups per resource, each several sequential LDAP
    // round-trips) ran unconditionally on every single list, which is what
    // made this route slow/unresponsive once a directory had more than a
    // handful of resources. Healing now happens where resources actually
    // change instead: POST /resources, PUT /resources/:id (see below), and
    // POST /discovery/promote/:slug. See POST /resources/heal-groups for an
    // on-demand equivalent of what this GET used to do implicitly, for
    // backfilling a directory seeded before this change.

    const projected = projectResources(resources, { fullMetadata: true }).map(r => {
      r.hasSecret = !!(r.metadata?.hasSecret || (r.metadata?.secretKeys && r.metadata.secretKeys.length > 0));
      r.secretKeys = r.metadata?.secretKeys || [];
      return r;
    });
    res.json({ results: projected });
  } catch (err) { next(err); }
});

// ── Spoke read-only enforcement + live replication trigger ──────────────────
// On a joined spoke the catalog is a copy of the master's; directory writes
// must go to the master (MULTI_SITE_SPEC.md — spoke = read-only catalog). Any
// mutating request below this point is rejected on a spoke with a pointer to
// the master. (site-status / site-promote live AFTER this middleware and are
// not directory writes.)
//
// On the MASTER, a successful mutation here fires a fire-and-forget resync
// push (utils/site_replicate.js) at every registered spoke, so the shipped
// join flow's one-time snapshot doesn't go stale the moment the catalog
// changes. Fires on res.on('finish') (after the response is actually sent,
// status known) rather than before the handler runs, so a write that fails
// validation never triggers a pointless replication round-trip.
// /site-promote is deliberately exempt below: it's the ONE mutating request a
// spoke must be able to make to itself (that's the entire point -- a spoke
// promoting itself to master). Without this exemption the gate 403s the
// promotion request before it ever reaches the handler, since this
// middleware is registered ahead of router.post('/site-promote', ...) later
// in the file and Express matches router.use() against every path.
router.use((req, res, next) => {
  const mutating = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
  if (mutating && req.path !== '/site-promote') {
    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      const hint = cfg.masterUrl ? ' Directory writes must go to the master at ' + cfg.masterUrl + '.' : '';
      return res.status(403).json({ status: 'error', message: 'This node is a spoke (read-only catalog).' + hint });
    }
    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        meshReplicate.replicateToSpokes(`${req.method} ${req.path}`);
      }
    });
  }
  next();
});

// On-demand equivalent of the group-model self-heal that GET /resources used
// to run implicitly on every list (see the comment there). Same fan-out,
// same idempotent ensure()-based helpers -- just explicit and admin-
// triggered instead of hidden in every page load, for backfilling a
// directory whose resources predate write-time healing.
router.post('/resources/heal-groups', async (req, res, next) => {
  try {
    const resources = await Resource.list();
    const sites = resources.filter(r => r.kind === 'site');
    await Promise.all(sites.map(site =>
      ensureSiteGroups(site.slug, req.user.dn, site.name, site.id)
        .catch(err => console.error(`ensureSiteGroups(${site.slug}) failed:`, err.message))
    ));
    const siteByResource = new Map();
    for (const site of sites) siteByResource.set(site.id, site.slug);
    const siteOf = async (r) => {
      const direct = siteByResource.get(r.id);
      if (direct) return direct;
      return await Resource.findAncestorSiteSlug(r.id).catch(() => null);
    };
    let healed = 0;
    await Promise.all(resources.map(async (r) => {
      const gKind = groupKind(r);
      if (!gKind) return;
      const siteSlug = await siteOf(r);
      if (!siteSlug) return;
      await provisionResourceGroups(r, gKind, siteSlug, req.user.dn)
        .then(() => { healed += 1; })
        .catch(err => console.error(`provisionResourceGroups(${r.slug}) failed:`, err.message));
    }));
    res.json({ status: 'ok', sitesHealed: sites.length, resourcesHealed: healed });
  } catch (err) { next(err); }
});

router.post('/resources', async (req, res, next) => {
  try {
    if (!req.body.hostId && req.body.parentSlug) {
      const parents = await Resource.list({ where: { slug: req.body.parentSlug } });
      if (parents.length > 0) req.body.hostId = parents[0].id;
    }
    
    if (req.body.kind !== 'site' && req.body.kind !== 'Site' && !req.body.hostId) {
      return res.status(400).json({ error: 'Only Site resources can be top-level. All other resource types must have a parent resource.' });
    }
    if (req.body.kind === 'host' && !req.body.hostId) {
      return res.status(400).json({ error: 'Hosts must have a parent Site or Host' });
    }
    if (req.body.kind === 'service' && !req.body.hostId) {
      return res.status(400).json({ error: 'Services must have a parent Host' });
    }
    if (req.body.kind === 'oauth' && !req.body.hostId) {
      return res.status(400).json({ error: 'OAuth Integrations must have a parent Service' });
    }
    
    req.body.owner = req.body.owner || req.user.uid;

    const now = Date.now();
    req.body.created_by = req.body.created_by || req.user.uid;
    req.body.created_on = now;
    req.body.updated_by = req.user.uid;
    req.body.updated_on = now;

    let r;
    if (req.body.kind === 'oauth') {
      const { OAuthClient } = require('../models/oauth_client');
      // Pass created_by explicitly for the wrapper (overrides the generic
      // assignment above -- this is OAuthClient-wrapper-specific behavior).
      req.body.created_by = req.body.owner;
      // In the UI we might pass slug, but OAuthClient wrapper expects name
      r = await OAuthClient.add(req.body);
    } else {
      r = await Resource.create(req.body);
    }

    if ((r.kind === 'host' || r.kind === 'service' || r.kind === 'oauth') && req.body.hostId) {
      await ResourceEdge.create({ parentId: req.body.hostId, childId: r.id, relation: r.kind === 'oauth' ? 'oauth' : 'hosts' });
    }

    // ── Group provisioning (docs/GROUPS.md) ───────────────────────────────
    // Materialize the group-model for the new resource. Site resources get the
    // site-level groups; host/app resources get their per-resource groups nested
    // into the site aggregates. Idempotent -- safe for a resource created by an
    // older release. A provisioning failure must not fail resource creation: the
    // resource already exists and the groups are repairable (re-run ensures them).
    //
    // `siteSlug` is the site resource's slug verbatim (`site_local`) -- the
    // group-model builders treat it as opaque (docs/GROUPS.md §3) and re-apply
    // the kind prefix themselves.
    const gKind = groupKind(r);
    const ancestorSite = await Resource.findAncestorSiteSlug(r.id);
    if (r.kind === 'site') {
      await ensureSiteGroups(r.slug, req.user.dn, r.name, r.id);
    } else if (gKind && ancestorSite) {
      await ensureSiteGroups(ancestorSite, req.user.dn, r.name); // backfill site tier if missing
      await provisionResourceGroups(r, gKind, ancestorSite, req.user.dn);
    }

    res.json({ results: r });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'A resource with this slug already exists.' });
    }
    if (err.name === 'SequelizeValidationError') {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.put('/resources/:id', async (req, res, next) => {
  try {
    // Validate before loading anything -- a rejected body should never have
    // touched the store.
    if (req.body.kind !== 'site' && req.body.kind !== 'Site' && !req.body.hostId) {
      return res.status(400).json({ error: 'Only Site resources can be top-level. All other resource types must have a parent resource.' });
    }
    if (req.body.kind === 'host' && !req.body.hostId) {
      return res.status(400).json({ error: 'Hosts must have a parent Site or Host' });
    }
    if (req.body.kind === 'service' && !req.body.hostId) {
      return res.status(400).json({ error: 'Services must have a parent Host' });
    }
    if (req.body.kind === 'oauth' && !req.body.hostId) {
      return res.status(400).json({ error: 'OAuth Integrations must have a parent Service' });
    }

    // OAuthClient is a wrapper over the same `resource` row, but its .update()
    // handles the oauth-specific body fields (redirect_uris, scopes,
    // token_lifetime) that a bare Resource would drop into metadata unvalidated.
    const { OAuthClient } = require('../models/oauth_client');
    const model = req.body.kind === 'oauth' ? OAuthClient : Resource;
    const r = await model.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });

    req.body.updated_by = req.user.uid;
    req.body.updated_on = Date.now();
    if (req.body.metadata && typeof req.body.metadata === 'object') {
      req.body.metadata = { ...(r.metadata || {}), ...req.body.metadata };
    }

    const updated = await r.update(req.body);

    if ((updated.kind === 'host' || updated.kind === 'service' || updated.kind === 'oauth') && req.body.hostId !== undefined) {
      const existingEdges = await ResourceEdge.list({ where: { childId: r.id } });
      for (const e of existingEdges) {
        if (e.relation === 'hosts' || e.relation === 'oauth') await e.delete();
      }
      if (req.body.hostId) {
        await ResourceEdge.create({ parentId: req.body.hostId, childId: r.id, relation: updated.kind === 'oauth' ? 'oauth' : 'hosts' });
      }
    }

    // Group provisioning (docs/GROUPS.md), same as POST /resources -- an
    // update can be what first makes a resource group-eligible (e.g. a
    // manual `metadata.managed` edit, or a reparent moving it under a
    // different site), and this route never provisioned groups at all
    // before. Never fails the update: groups are repairable via
    // POST /resources/heal-groups if this best-effort attempt fails.
    const gKind = groupKind(updated);
    if (gKind) {
      const ancestorSite = await Resource.findAncestorSiteSlug(updated.id).catch(() => null);
      if (ancestorSite) {
        await ensureSiteGroups(ancestorSite, req.user.dn, updated.name)
          .catch(err => console.error(`ensureSiteGroups(${ancestorSite}) failed:`, err.message));
        await provisionResourceGroups(updated, gKind, ancestorSite, req.user.dn)
          .catch(err => console.error(`provisionResourceGroups(${updated.slug}) failed:`, err.message));
      }
    }

    res.json({ results: updated });
  } catch (err) {
    next(err);
  }
});

router.post('/resources/:id/rotate-secret', async (req, res, next) => {
    try {
        const { OAuthClient } = require('../models/oauth_client');
        const client = await OAuthClient.get(req.params.id);
        const secret = await client.rotateSecret();
        res.json({ secret });
    } catch (err) {
        next(err);
    }
});

router.post('/resources/:id/service-token', async (req, res, next) => {
    try {
        const { ServiceToken } = require('../models/token');
        const token = await ServiceToken.issue(req.params.id, req.user.uid);
        res.json({ results: { token: token.token } });
    } catch (err) {
        next(err);
    }
});

router.delete('/resources/:id', async (req, res, next) => {
  try {
    const r = await Resource.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    // Clear the dependents FIRST. There is no transaction here, so ordering is
    // the only thing protecting us: if a dependent delete throws after the
    // resource row is gone, the leftovers are edges/links pointing at a
    // nonexistent id -- invisible in the UI and poisonous to getGraph(). Failing
    // with the resource still present is the recoverable direction (retry the
    // delete); the caller sees the error either way.
    const edgesParent = await ResourceEdge.list({ where: { parentId: req.params.id } });
    const edgesChild = await ResourceEdge.list({ where: { childId: req.params.id } });
    const groups = await ResourceGroup.list({ where: { resourceId: req.params.id } });
    for (const e of [...edgesParent, ...edgesChild]) await e.delete();
    for (const g of groups) await g.delete();
    await r.delete();
    res.json({ results: true });
  } catch (err) { next(err); }
});

// --- Edges ---
router.get('/edges', async (req, res, next) => {
  try {
    const edges = await ResourceEdge.list();
    res.json({ results: edges });
  } catch (err) { next(err); }
});

router.post('/edges', async (req, res, next) => {
  try {
    const edge = await ResourceEdge.create(req.body);
    res.json({ results: edge });
  } catch (err) { next(err); }
});

router.delete('/edges/:id', async (req, res, next) => {
  try {
    const edge = await ResourceEdge.get(req.params.id);
    if (!edge) return res.status(404).json({ error: 'Not found' });
    await edge.delete();
    res.json({ results: true });
  } catch (err) { next(err); }
});

// --- Groups ---
router.get('/groups', async (req, res, next) => {
  try {
    const groups = await ResourceGroup.list();
    res.json({ results: groups });
  } catch (err) { next(err); }
});

router.post('/groups', async (req, res, next) => {
  try {
    const { resourceId, groupCn } = req.body;
    if (!resourceId || !groupCn) return res.status(400).json({ error: 'resourceId and groupCn are required' });

    // Enforce the group-model naming convention (docs/GROUPS.md §3). The CN must
    // be a valid group for this resource; reject free-form names so the groups
    // consumers read are always parseable. god_admin is always allowed (it is
    // the global group and is managed from a site's modal).
    const resource = await Resource.get(resourceId);
    // Full site slug verbatim (`site_local`) -- the builders take it as-is. A
    // site resource's own slug is its site; a host/app uses its ancestor site.
    const siteSlug = resource && resource.kind === 'site'
      ? resource.slug
      : await Resource.findAncestorSiteSlug(resourceId);
    if (resource && siteSlug && groupCn !== groups.GOD_ADMIN) {
      const { valid, capRe } = validGroupCnsForResource(resource, siteSlug);
      if (!valid.has(groupCn) && !(capRe && capRe.test(groupCn))) {
        const err = new Error(`"${groupCn}" is not a valid group for this ${resource.kind}. Use the resource's own groups, a site aggregate, a site-level group, or god_admin (e.g. ${[...valid].join(', ')}).`);
        err.status = 400;
        throw err;
      }
    }

    const g = await ensureResourceGroup(req.body.resourceId, groupCn, req.body.accessLevel);
    res.json({ results: g });
  } catch (err) { next(err); }
});

router.delete('/groups/:id', async (req, res, next) => {
  try {
    const g = await ResourceGroup.get(req.params.id);
    if (!g) return res.status(404).json({ error: 'Not found' });
    await g.delete();
    res.json({ results: true });
  } catch (err) { next(err); }
});

// --- Access visibility ---
//
// The two questions an access-control pane has to answer, neither of which the
// directory could answer before: "who can reach this resource" (a column on the
// table, rather than three clicks into a modal) and "what can this user reach"
// (which had no UI at all). Both are joins of the same two sets, so both are
// served from one cached Group.listDetail() rather than a lookup per row.

// dn -> uid, so member DNs can be reported as the uids admins actually think in.
async function dnToUidMap() {
  const users = await User.listDetail();
  return new Map(users.map(u => [String(u.dn).toLowerCase(), u.uid]));
}

// GET /access-summary — { resourceId: { groups: [...], memberCount } }
router.get('/access-summary', async (req, res, next) => {
  try {
    const [links, groups, uidByDn] = await Promise.all([
      ResourceGroup.list(),
      Group.listDetail(),
      dnToUidMap(),
    ]);

    const groupByCn = new Map(groups.map(g => [g.cn, g]));
    const summary = {};

    for (const link of links) {
      const group = groupByCn.get(link.groupCn);
      // A link whose LDAP group has been deleted out from under it: report it
      // rather than skipping, since a dangling link grants nothing and the
      // admin needs to see that it is dead.
      //
      // Counts come from the transitive closure, not from `member`. Reading the
      // attribute would report only who is listed on the group, missing anyone
      // who reaches it through a nested group -- and since god_admin is
      // nested into every resource's _admin group, that is not an edge case.
      let members = [];
      if (group) {
        const eff = await Group.effectiveMembers(link.groupCn);
        members = eff.effective.map(dn => uidByDn.get(String(dn).toLowerCase()) || cnFromDn(dn));
      }

      const entry = summary[link.resourceId] || (summary[link.resourceId] = { groups: [], members: [] });
      entry.groups.push({
        cn: link.groupCn,
        accessLevel: link.accessLevel,
        exists: !!group,
        memberCount: members.length,
      });
      for (const uid of members) {
        if (!entry.members.includes(uid)) entry.members.push(uid);
      }
    }

    for (const id of Object.keys(summary)) {
      summary[id].memberCount = summary[id].members.length;
    }

    res.json({ results: summary });
  } catch (err) { next(err); }
});

// GET /user-access/:uid — every resource a given user can reach, and via which
// group. This is the reverse lookup; previously an admin could only see their
// own access, via /api/discovery/me.
router.get('/user-access/:uid', async (req, res, next) => {
  try {
    const user = await User.get({ uid: req.params.uid });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const dn = String(user.dn).toLowerCase();
    const groups = await Group.listDetail();
    const memberOf = groups
      .filter(g => [].concat(g.member || []).some(m => String(m).toLowerCase() === dn))
      .map(g => g.cn);

    const [links, resources] = await Promise.all([ResourceGroup.list(), Resource.list()]);
    const byId = new Map(resources.map(r => [r.id, r]));

    const results = [];
    for (const link of links) {
      if (!memberOf.includes(link.groupCn)) continue;
      const resource = byId.get(link.resourceId);
      if (!resource) continue;
      results.push({
        id: resource.id,
        name: resource.name,
        slug: resource.slug,
        kind: resource.kind,
        groupCn: link.groupCn,
        accessLevel: link.accessLevel,
      });
    }

    res.json({ results: { uid: user.uid, groups: memberOf, resources: results } });
  } catch (err) { next(err); }
});

// Tail the last `lines` lines of a log file without shelling out. Reads at most
// the trailing MAX_TAIL_BYTES so an unrotated multi-GB log can't blow up the
// heap. A missing/unreadable file is normal (the log only exists once slapd has
// written to it), so it yields '' rather than an error.
const MAX_TAIL_BYTES = 256 * 1024;

async function tailFile(filePath, lines = 100) {
  const fs = require('fs/promises');
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
    const { size } = await fh.stat();
    const start = Math.max(0, size - MAX_TAIL_BYTES);
    const buf = Buffer.alloc(Math.min(size, MAX_TAIL_BYTES));
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // A partial first line when we started mid-file; drop it.
    const rows = (start > 0 ? text.slice(text.indexOf('\n') + 1) : text).split('\n');
    return rows.slice(-lines).join('\n');
  } catch (err) {
    return '';
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

router.get('/audit-logs', async (req, res, next) => {
  try {
    const [ldap, oauth, audit] = await Promise.all([
      tailFile('/var/lib/ldap/slapd.log'),
      tailFile('/var/lib/ldap/oauth.log'),
      tailFile('/var/lib/ldap/auditlog.ldif'),
    ]);
    res.json({ results: { ldap, oauth, audit } });
  } catch (err) { next(err); }
});

// ── Resource Secrets API (OpenBao KV-v2 under secret/data/resources/<slug>/conf) ──
const SECRET_KEY_REGEX = /^[A-Za-z0-9_]+$/;

router.get('/resources/:id/secrets', async (req, res, next) => {
  try {
    const resource = await Resource.get(req.params.id);
    if (!resource) return res.status(404).json({ status: 'error', message: 'resource not found' });
    const baoConf = require('@simpleworkjs/bao-conf');

    // Read resource secrets from OpenBao
    const path = `secret/data/resources/${resource.slug}/conf`;
    const r = await baoConf.request('GET', path);
    let secretsMap = {};
    if (r.ok) {
      const body = await r.json().catch(() => ({}));
      secretsMap = (body.data && body.data.data) || {};
    }

    // Zero-View Security: Return metadata only, NEVER return raw secret values
    const secrets = Object.keys(secretsMap).map(key => {
      const val = String(secretsMap[key] || '');
      let isInherited = false;
      let parentSlug = null;
      let parentKey = null;

      if (val.startsWith('INHERIT:')) {
        isInherited = true;
        const parts = val.split(':');
        if (parts.length >= 3) {
          parentSlug = parts[1];
          parentKey = parts[2];
        } else if (parts.length === 2) {
          parentKey = parts[1];
        }
      }

      return {
        key,
        hasValue: val.length > 0,
        isInherited,
        parentSlug,
        parentKey
      };
    });

    // Explicit Secret Inheritance Lineage:
    // Find ancestor resources in direct upward path (Host, Cluster, Site)
    const parentSecrets = [];
    const seenAncestors = new Set();

    const ancestors = await Resource.findAllAncestors(resource.id).catch(() => []);
    const sites = await Resource.list({ where: { kind: 'site' } }).catch(() => []);
    const candidateAncestors = [...ancestors];
    for (const site of sites) {
      if (!candidateAncestors.some(a => a.id === site.id)) {
        candidateAncestors.push(site);
      }
    }

    for (const parent of candidateAncestors) {
      if (!parent || parent.id === resource.id || seenAncestors.has(parent.id)) continue;
      seenAncestors.add(parent.id);

      const parentPath = `secret/data/resources/${parent.slug}/conf`;
      const parentR = await baoConf.request('GET', parentPath);
      if (parentR.ok) {
        const parentBody = await parentR.json().catch(() => ({}));
        const pMap = (parentBody.data && parentBody.data.data) || {};
        for (const pKey of Object.keys(pMap)) {
          const pVal = String(pMap[pKey] || '');
          // Ancestor's own secrets (not pointers) are candidates for explicit inheritance
          if (!pVal.startsWith('INHERIT:')) {
            parentSecrets.push({
              parentSlug: parent.slug,
              parentName: `${parent.name} (${parent.kind ? parent.kind.toUpperCase() : 'ANCESTOR'})`,
              key: pKey
            });
          }
        }
      }
    }

    res.json({ status: 'ok', resourceId: resource.id, slug: resource.slug, secrets, parentSecrets });
  } catch (err) { next(err); }
});

router.post('/resources/:id/secrets', async (req, res, next) => {
  try {
    const resource = await Resource.get(req.params.id);
    if (!resource) return res.status(404).json({ status: 'error', message: 'resource not found' });
    const baoConf = require('@simpleworkjs/bao-conf');
    const path = `secret/data/resources/${resource.slug}/conf`;

    // Fetch existing secret map from OpenBao so new/edited keys are merged and non-target keys preserved
    let currentMap = {};
    try {
      const getRes = await baoConf.request('GET', path);
      if (getRes.ok) {
        const body = await getRes.json().catch(() => ({}));
        currentMap = (body.data && body.data.data) || {};
      }
    } catch (e) {}

    if (req.body.action === 'delete' && req.body.key) {
      delete currentMap[req.body.key];
    } else if (req.body.secrets && typeof req.body.secrets === 'object') {
      for (const [key, val] of Object.entries(req.body.secrets)) {
        if (!SECRET_KEY_REGEX.test(key)) {
          return res.status(400).json({
            status: 'error',
            message: `Invalid secret key '${key}'. Keys must contain only letters, numbers, and underscores (e.g. DB_PASSWORD)`
          });
        }
        currentMap[key] = val;
      }
    }

    const r = await baoConf.request('POST', path, { data: currentMap });
    if (!r.ok) {
      return res.status(500).json({ status: 'error', message: 'failed to save secrets to OpenBao' });
    }

    const keys = Object.keys(currentMap);
    const updatedMeta = {
      ...(resource.metadata || {}),
      hasSecret: keys.length > 0,
      secretKeys: keys
    };
    await resource.update({ metadata: updatedMeta }).catch(() => {});

    res.json({ status: 'ok', keys });
  } catch (err) { next(err); }
});

router.get('/resources/:id/grants', async (req, res, next) => {
  try {
    const { SharedSecretGrant } = require('../models/shared_secret_grant');
    const { SharedSecret } = require('../models/shared_secret');
    const resource = await Resource.get(req.params.id);
    if (!resource) return res.status(404).json({ status: 'error', message: 'resource not found' });
    const grants = await SharedSecretGrant.listForGrantee('resource', resource.id);
    const sharedSecretIds = grants.map(g => g.secretId);
    const secrets = sharedSecretIds.length ? await SharedSecret.list({ where: { id: { in: sharedSecretIds } } }) : [];
    res.json({ status: 'ok', grants: secrets.map(s => ({ id: s.id, slug: s.slug, description: s.description })) });
  } catch (err) { next(err); }
});

router.post('/resources/:id/grants', async (req, res, next) => {
  try {
    const { SharedSecretGrant } = require('../models/shared_secret_grant');
    const { SharedSecret } = require('../models/shared_secret');
    const resource = await Resource.get(req.params.id);
    if (!resource) return res.status(404).json({ status: 'error', message: 'resource not found' });
    const { secretSlug, action } = req.body || {};
    const secret = await SharedSecret.getBySlug(secretSlug);
    if (!secret) return res.status(404).json({ status: 'error', message: `shared secret '${secretSlug}' not found` });

    if (action === 'revoke') {
      const existing = await SharedSecretGrant.list({ where: { secretId: secret.id, granteeType: 'resource', granteeId: resource.id } });
      for (const g of existing) await g.delete();
      return res.json({ status: 'ok', message: 'grant revoked' });
    } else {
      await SharedSecretGrant.grant({ secretId: secret.id, granteeType: 'resource', granteeId: resource.id, grantedBy: req.user.uid });
      return res.json({ status: 'ok', message: 'grant created' });
    }
  } catch (err) { next(err); }
});

// ── Subtype Drivers Operations API ───────────────────────────────────────────
const DriverRegistry = require('../services/driver_registry');

router.get('/resources/:id/driver-metrics', async (req, res, next) => {
  try {
    const resource = await Resource.get(req.params.id);
    if (!resource) return res.status(404).json({ status: 'error', message: 'resource not found' });
    const metrics = await DriverRegistry.getMetrics(resource);
    res.json({ status: 'ok', resourceId: resource.id, metrics });
  } catch (err) { next(err); }
});

router.post('/resources/:id/driver-action', async (req, res, next) => {
  try {
    const resource = await Resource.get(req.params.id);
    if (!resource) return res.status(404).json({ status: 'error', message: 'resource not found' });
    const { action, params } = req.body || {};
    if (!action) return res.status(400).json({ status: 'error', message: 'action is required' });
    const actionParams = params || req.body || {};
    const result = await DriverRegistry.execAction(resource, action, actionParams);
    res.json({ status: 'ok', resourceId: resource.id, result });
  } catch (err) { next(err); }
});

router.get('/resources/:id/driver-logs', async (req, res, next) => {
  try {
    const resource = await Resource.get(req.params.id);
    if (!resource) return res.status(404).json({ status: 'error', message: 'resource not found' });
    const lines = parseInt(req.query.lines, 10) || 100;
    const logs = await DriverRegistry.getLogs(resource, lines);
    res.json({ status: 'ok', resourceId: resource.id, logs });
  } catch (err) { next(err); }
});

// ── Discovered Inventory Operations (Merge & Ignore) ───────────────────────
router.post('/discovered/ignore', async (req, res, next) => {
  try {
    const { resourceId } = req.body;
    if (!resourceId) return res.status(400).json({ status: 'error', message: 'resourceId is required' });
    const r = await Resource.get(resourceId);
    if (!r) return res.status(404).json({ status: 'error', message: 'resource not found' });
    
    r.metadata = r.metadata || {};
    r.metadata.ignored = true;
    await r.save();
    res.json({ status: 'ok', resourceId: r.id, ignored: true });
  } catch (err) { next(err); }
});

router.post('/discovered/merge', async (req, res, next) => {
  try {
    const { discoveredId, targetId } = req.body;
    if (!discoveredId || !targetId) {
      return res.status(400).json({ status: 'error', message: 'discoveredId and targetId are required' });
    }
    const disc = await Resource.get(discoveredId);
    const target = await Resource.get(targetId);
    if (!disc || !target) {
      return res.status(404).json({ status: 'error', message: 'Discovered or Target resource not found' });
    }

    // Merge metadata (interfaces, discovery sources, OS details)
    target.metadata = target.metadata || {};
    disc.metadata = disc.metadata || {};

    const sources = new Set([...(target.metadata.discovery_sources || []), ...(disc.metadata.discovery_sources || [])]);
    target.metadata.discovery_sources = Array.from(sources);

    if (disc.metadata.interfaces) {
      const existingInterfaces = target.metadata.interfaces || [];
      const macs = new Set(existingInterfaces.map(i => i.mac).filter(Boolean));
      for (const iface of disc.metadata.interfaces) {
        if (!iface.mac || !macs.has(iface.mac)) {
          existingInterfaces.push(iface);
        }
      }
      target.metadata.interfaces = existingInterfaces;
    }

    if (disc.metadata.os) target.metadata.os = target.metadata.os || disc.metadata.os;
    if (disc.metadata.kernel) target.metadata.kernel = target.metadata.kernel || disc.metadata.kernel;

    await target.save();

    // Remove or mark discovered record as merged
    await disc.delete();

    res.json({ status: 'ok', mergedTargetId: target.id, targetName: target.name });
  } catch (err) { next(err); }
});

// ── Multi-Site & Master Node Status Endpoints ────────────────────────────────
// The site role (master/spoke, site slug, master URL) is persisted by
// utils/site_config.js so it survives restarts; the env vars IS_MASTER /
// MASTER_URL / SITE_SLUG only seed the defaults. site-promote and the
// /api/site/join flow both write to it.
const siteConfig = require('../utils/site_config');
const { siteIsFresh } = require('../utils/site_join');
const { Agent } = require('../models/agent');
const { SiteSpoke } = require('../models/site_spoke');
const { ldapHostFor } = require('../utils/ldap_replication');

// probeMasterHealth checks whether this (spoke) node can reach its master over
// the site join key. The master's /api/site/ping is deliberately lightweight.
async function probeMasterHealth(cfg) {
  if (cfg.isMaster) return true;
  if (!cfg.masterUrl || !cfg.masterJoinKey) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(String(cfg.masterUrl).replace(/\/+$/, '') + '/api/site/ping', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.masterJoinKey, 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal
    });
    return resp.ok;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

router.get('/site-status', async (req, res, next) => {
  try {
    const sites = await Resource.list({ where: { kind: 'site' } });

    const cfg = siteConfig.get();
    const wanConnected = await probeMasterHealth(cfg);
    let canJoin = false;
    if (cfg.isMaster) {
      canJoin = await siteIsFresh({ User, Agent }).catch(() => false);
    }
    // registeredSpokesCount (master) / liveReplication (spoke): surfaces
    // whether live replication is actually wired up, not just whether the
    // join itself succeeded -- a spoke that joined without `selfUrl` (e.g.
    // via an older bootstrap, or the UI form before it grew the field) is
    // fully joined but silently stuck on the one-time snapshot, which was
    // otherwise invisible anywhere in the UI.
    const registeredSpokesCount = cfg.isMaster ? await SiteSpoke.list().then(l => l.length).catch(() => 0) : 0;
    // Real gateway-to-gateway mesh peer count from jump-host's own registry
    // (utils/jump_client.js), not this app's unrelated WireGuard
    // roaming-client Resources. count is null (not 0) when the query
    // couldn't run at all -- the UI distinguishes "0 gateways" from "can't
    // tell" instead of showing a misleading zero.
    const gateways = await jumpClient.getGatewayCount();
    res.json({
      status: 'ok',
      config: {
        isMaster: cfg.isMaster,
        masterUrl: cfg.masterUrl,
        siteSlug: cfg.siteSlug,
        wanConnected,
        siteMode: cfg.isMaster ? 'master' : 'spoke',
        canJoin,
        liveReplication: !cfg.isMaster ? !!cfg.replicationPushToken : undefined,
        registeredSpokesCount
      },
      sitesCount: sites.length,
      sites: sites.map(s => ({ id: s.id, name: s.name, slug: s.slug })),
      gatewaysCount: gateways.count,
      gatewaysNote: gateways.note
    });
  } catch (err) { next(err); }
});

// OpenLDAP multi-master replication config for THIS node (docs/replication.md).
// Master-only: the master already has every registered spoke's info locally
// (SiteSpoke), so it can compute its own ServerID (always 1) + full peer
// list without an HTTP round-trip. A spoke gets its config from the master
// directly instead (GET /api/site/ldap-peers -- see bootstrap/
// site-ldap-register.js in theta-suite, which calls whichever of the two
// applies to this node's role).
router.get('/ldap-replication-config', async (req, res, next) => {
  try {
    const cfg = siteConfig.get();
    if (!cfg.isMaster) {
      return res.status(400).json({ status: 'error', message: 'this node is a spoke -- fetch replication config from the master via GET /api/site/ldap-peers instead' });
    }
    const spokes = await SiteSpoke.list();
    const peers = [];
    for (const s of spokes) {
      if (!s.ldapServerId) continue;
      const host = ldapHostFor(s.endpoint);
      if (host) peers.push({ ldapServerId: s.ldapServerId, ldapHost: host });
    }
    res.json({ status: 'ok', ldapServerId: 1, peers });
  } catch (err) { next(err); }
});

router.post('/site-promote', async (req, res, next) => {
  try {
    // god_admin privilege check. This used to read req.user.groups, which
    // nothing in the codebase ever populates -- User.get() (what
    // Auth.checkToken returns as req.user) has no .groups field; every other
    // admin gate in this app resolves membership live via
    // permission.byGroup()/Group.list(user.dn), which also correctly
    // resolves NESTED group membership (a user who is god_admin via a nested
    // group, not just direct membership). The old check silently evaluated
    // to an empty array for every request, making this endpoint
    // unreachable for ANY user -- caught by the multi-site e2e promotion
    // test (docker-compose.multisite-e2e.yml), not by inspection.
    const isGodAdmin = await permission.byGroup(req.user, [SUPER_ADMIN_GROUP]).catch(() => false);
    if (!isGodAdmin) {
      return res.status(403).json({ status: 'error', message: 'Master promotion requires explicit god_admin authority' });
    }

    // MULTI_SITE_SPEC.md §3.2: promotion is ONE coordinated action, never a
    // manual two-step "demote the old one first" — if we currently know a
    // master (we were a spoke), hand it off before flipping ourselves. This
    // is best-effort: an unreachable old master (the whole point of the
    // WAN-outage promotion scenario §3 describes) must never block a
    // god_admin's local promotion, it's just reported so the operator can
    // reconcile it manually.
    const beforeCfg = siteConfig.get();
    let handoffNote = 'no previous master on file (already master, or fresh install)';
    if (!beforeCfg.isMaster && beforeCfg.masterUrl && beforeCfg.masterJoinKey) {
      try {
        const { raw: freshKey } = await SiteJoinKey.issue({
          label: 'promotion-handoff-' + new Date().toISOString().slice(0, 10),
          createdBy: req.user ? req.user.uid : 'admin'
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        let resp;
        try {
          resp = await fetch(beforeCfg.masterUrl + '/api/site/demote', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + beforeCfg.masterJoinKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ newMasterUrl: (req.body && req.body.selfUrl) || '', newJoinKey: freshKey }),
            signal: controller.signal
          });
        } finally { clearTimeout(timer); }
        handoffNote = resp.ok ? 'previous master demoted' : ('previous master demote failed: HTTP ' + resp.status);
      } catch (e) {
        handoffNote = 'previous master unreachable (' + e.message + ') — promoted locally anyway; reconcile it manually once it\'s back';
      }
    }

    siteConfig.save({ isMaster: true, masterUrl: '', masterJoinKey: undefined });

    console.log(`[MULTI-SITE] Node promoted to MASTER by user ${req.user ? req.user.uid : 'admin'} (handoff: ${handoffNote})`);

    // Fire-and-forget: let every known spoke know a new master exists so
    // their next resync targets it. (They'll also learn this the hard way if
    // their old-master resync calls start failing, but this speeds it up.)
    meshReplicate.replicateToSpokes('master-promoted');

    const cfg = siteConfig.get();
    res.json({
      status: 'ok',
      message: 'Node successfully promoted to Master Site',
      handoff: handoffNote,
      config: {
        isMaster: true,
        masterUrl: '',
        siteSlug: cfg.siteSlug,
        siteMode: 'master'
      }
    });
  } catch (err) { next(err); }
});

module.exports = router;
