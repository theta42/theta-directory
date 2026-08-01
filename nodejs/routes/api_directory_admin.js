'use strict';
const router = require('express').Router();
const permission = require('../utils/permission');
const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { Group } = require('../models/group_ldap');
const { User } = require('../models/user_ldap');
const { cnFromDn } = require('../utils/user_groups');
const { projectResources } = require('@simpleworkjs/directory-schema');

const SUPER_ADMIN_GROUP = permission.SUPER_ADMIN_GROUP;

// Make `childCn` a member of `parentCn`, i.e. everyone in the child is
// transitively in the parent. Idempotent and non-fatal: "already a member" is
// the goal state, and a missing group (e.g. app_super_admin absent on a
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
      const isAuto = r.metadata?.discovery_sources?.length > 0 && !r.metadata.discovery_sources.includes('manual');
      const isManaged = r.metadata?.managed === true;
      return !isAuto || isManaged;
    });
    // Even admins never receive secret metadata (e.g. client_secret_hash) over
    // the wire; projectResources strips it unconditionally.
    res.json({ results: projectResources(resources, { fullMetadata: true }) });
  } catch (err) { next(err); }
});

router.post('/resources', async (req, res, next) => {
  try {
    if (!req.body.hostId && req.body.parentSlug) {
      const parents = await Resource.list({ where: { slug: req.body.parentSlug } });
      if (parents.length > 0) req.body.hostId = parents[0].id;
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

    if (r.kind === 'host' || r.kind === 'service') {
      const siteSlug = await Resource.findAncestorSiteSlug(r.id);
      const groupCn = suffix => (siteSlug ? `${siteSlug}_${r.slug}_${suffix}` : `${r.slug}_${suffix}`);

      const createGroup = async (suffix, accessLevel) => {
        const cn = groupCn(suffix);
        try {
          await Group.add({
            name: cn,
            owner: req.user.dn,
            description: `${suffix === 'admin' ? 'Admin' : 'Access'} group for ${r.name}`
          });
        } catch (err) {
          if (err.name !== 'EntryAlreadyExistsError' && err.code !== 68) {
            console.error(`Failed to create LDAP group ${cn}:`, err);
          }
        }
        try {
          await ResourceGroup.create({ resourceId: r.id, groupCn: cn, accessLevel });
        } catch(err) { /* ignore duplicate links */ }
      };
      await createGroup('access', 'member');
      await createGroup('admin', 'owner');

      // Wire up the two standing relationships every resource has, as nesting
      // rather than as membership that has to be maintained per resource:
      //
      //   app_super_admin -> <slug>_admin   cross-app super admins administer
      //                                     every resource, automatically
      //   <slug>_admin    -> <slug>_access  administering something implies
      //                                     being able to use it
      //
      // Before nesting, both of these could only be expressed by adding every
      // super admin to every new group by hand -- which nobody does, so the
      // groups drifted. A failure here must not fail resource creation: the
      // resource and its groups already exist and the nesting is repairable.
      await nestGroup(groupCn('admin'), groupCn('access'));
      await nestGroup(SUPER_ADMIN_GROUP, groupCn('admin'));
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
    const g = await ResourceGroup.create(req.body);
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
      // who reaches it through a nested group -- and since app_super_admin is
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

module.exports = router;
