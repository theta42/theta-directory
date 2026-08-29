'use strict';

// Public directory discovery API. Mounted at /api/discovery (app.js, before
// the 404 catcher). Every response uses the `{ results }` envelope and the
// security projection from @simpleworkjs/directory-schema, so secrets (e.g. an
// OAuth client's client_secret_hash) never leave the server and non-admins only
// see the public metadata allowlist.
//
// This replaces the autoRouter mount (which returned bare arrays — the shape
// jump-host's `data.results || []` silently collapsed to `[]`, so no user could
// bridge) and absorbs the dead /me handler that used to live in
// routes/api_discovery.js (mounted after the 404, so unreachable).
//
// Group CNs come from utils/user_groups — `req.user` has `memberOf` (DNs) and
// no `.groups`, so reading `.groups` off it directly yields [] for every human
// caller. See that file for what that silently broke.

const router = require('express').Router();
const { Resource, ResourceGroup } = require('../models/resource');
const { withGroups } = require('../utils/user_groups');
const { accessibleResources } = require('../services/access_projection');
const {
	envelope,
	projectResource,
	projectResources,
	isDirectoryAdmin,
} = require('@simpleworkjs/directory-schema');


// The whole edge list, for the access projection's site walk. One query per
// request rather than one per resource.
async function allEdges() {
	const { ResourceEdge } = require('../models/resource');
	return ResourceEdge.list().catch(() => []);
}

// The enrolled agents. Access projection now resolves `Agent.resourceId` to the
// theta-agent service child in the graph, so no metadata.agentId is trusted.
// The grants a set of group CNs actually holds, as resourceId -> accessLevel.
// The level matters now that access propagates down the tree: a viewer on a
// site must not become an admin on its hosts.
async function grantsFor(groupCns) {
	const grants = new Map();
	const nonInheriting = new Map();
	if (!groupCns || !groupCns.length) return { grants, nonInheriting };

	const { strongest } = require('../services/access_inheritance');
	const { isMetaGroup } = require('../utils/groups');
	const rgs = await ResourceGroup.list({ where: { groupCn: { in: groupCns } } }).catch(() => []);
	for (const rg of rgs) {
		// A meta/roster group grants the resource it is linked to and nothing
		// below it. See utils/groups.js isMetaGroup.
		const target = isMetaGroup(rg.groupCn) ? nonInheriting : grants;
		target.set(rg.resourceId, strongest(target.get(rg.resourceId), rg.accessLevel || 'access'));
	}
	return { grants, nonInheriting };
}

async function enrolledAgents() {
	const { Agent } = require('../models/agent');
	return await Agent.list().catch(() => []);
}

// Resolve the caller's groups once per request and hand back the projection
// flag. Every handler needs both, and both are wrong if taken off req.user raw.
async function callerView(req) {
	const user = await withGroups(req.user);
	return { user, fullMetadata: isDirectoryAdmin(user) };
}

// GET /api/discovery/resources[?kind=&group=&parent=]

// GET /api/discovery/port-forwards
// Answers the firewall consumer with port-forward services and their host/site.
router.get('/port-forwards', async (req, res, next) => {
	try {
		const { fullMetadata } = await callerView(req);
		const allResources = await Resource.list();
		const portForwards = allResources.filter(r => r.kind === 'service' && r.metadata && r.metadata.subType === 'port-forward');
		
		const results = [];
		for (const pf of portForwards) {
			const ancestors = await Resource.findAllAncestors(pf.id);
			const host = ancestors.find(a => a.kind === 'host');
			const site = ancestors.find(a => a.kind === 'site');
			
			const projectedPf = projectResource(pf, { fullMetadata });
			projectedPf.host = host ? projectResource(host, { fullMetadata }) : null;
			projectedPf.site = site ? projectResource(site, { fullMetadata }) : null;
			
			results.push(projectedPf);
		}
		
		res.json(envelope(results));
	} catch (err) { next(err); }
});

router.get('/resources', async (req, res, next) => {
	try {
		const { fullMetadata } = await callerView(req);
		const resources = await Resource.search(req.query);
		res.json(envelope(projectResources(resources, { fullMetadata })));
	} catch (err) { next(err); }
});

// GET /api/discovery/resources/:slug
router.get('/resources/:slug', async (req, res, next) => {
	try {
		const { fullMetadata } = await callerView(req);
		const resource = await Resource.getBySlug(req.params.slug);
		// parents/children are edges (no secrets); project only the resource body.
		const projected = projectResource(resource, { fullMetadata });
		projected.parents = resource.parents;
		projected.children = resource.children;
		res.json(envelope(projected));
	} catch (err) { next(err); }
});

// GET /api/discovery/graph
router.get('/graph', async (req, res, next) => {
	try {
		const { fullMetadata } = await callerView(req);
		const graph = await Resource.getGraph();
		res.json(envelope({
			resources: projectResources(graph.resources, { fullMetadata }),
			edges: graph.edges,
			updated_on: graph.updated_on
		}));
	} catch (err) { next(err); }
});

// GET /api/discovery/me
// Returns the resources the current caller can reach. Machines see only their
// own resource; humans get the union of their LDAP groups' resources plus
// anything flagged isPublic.
router.get('/me', async (req, res, next) => {
	try {
		const { user, fullMetadata } = await callerView(req);
		let accessible;
		if (req.user && req.user.isMachine) {
			accessible = await Resource.list({ where: { id: req.resourceId } });
		} else {
			const all = await Resource.list();
			accessible = accessibleResources(all, await allEdges(),
				{ ...(await grantsFor(user.groups)), memberOf: user.groups, agents: await enrolledAgents() });
		}
		// resolvedAddress is the whole point of /me ("how do I reach it") and a
		// service inherits it from its host, so it must be computed here rather
		// than left to each caller to guess at address || ip.
		accessible = await Resource.withResolvedAddress(accessible);
		res.json(envelope(projectResources(accessible, { fullMetadata })));
	} catch (err) { next(err); }
});

// GET /api/discovery/access/:uid[/:slug]
// Answers per-user access for a machine caller (e.g. jump-host).
router.get(['/access/:uid', '/access/:uid/:slug'], async (req, res, next) => {
	try {
		const { fullMetadata } = await callerView(req);
		if (!req.user || (!req.user.isMachine && !fullMetadata)) {
			return res.status(403).json(envelope({ error: 'Only machine identities or admins may query access for other users.' }));
		}
		const { User } = require('../models/user_ldap');
		const { groupCns } = require('../utils/user_groups');
		
		const targetUser = await User.get(req.params.uid).catch(() => null);
		if (!targetUser) return res.status(404).json(envelope({ error: 'User not found' }));

		const groups = await groupCns(targetUser);

		// The whole catalog, not just the requested slug: a service inherits
		// access from its host, so filtering to one slug BEFORE the projection
		// would hide the host the decision depends on and answer "no access"
		// for a service the user can plainly reach.
		const all = await Resource.list();
		let accessible = accessibleResources(all, await allEdges(),
			{ ...(await grantsFor(groups)), memberOf: groups, agents: await enrolledAgents() });
		if (req.params.slug) accessible = accessible.filter(r => r.slug === req.params.slug);
		
		accessible = await Resource.withResolvedAddress(accessible);
		res.json(envelope(projectResources(accessible, { fullMetadata })));
	} catch (err) { next(err); }
});

// POST /api/discovery/sync
// Used by external agents (e.g. ldap-client) to push discovery data.
router.post('/sync', async (req, res, next) => {
	try {
		const { isDirectoryAdmin } = require('@simpleworkjs/directory-schema');
		const { withGroups } = require('../utils/user_groups');
const { accessibleResources } = require('../services/access_projection');
		const user = await withGroups(req.user);
		if (!isDirectoryAdmin(user) && !user.isMachine) {
			return res.status(403).json(envelope({ error: 'Only admins or machines can sync discovery' }));
		}
		const { DiscoveryReconciler } = require('../services/discovery_reconciler');
		// Assuming the caller provides a source name and payload
		const source = req.body.source || 'agent';
		await DiscoveryReconciler.reconcile(source, req.body.payload || req.body);
		res.json(envelope({ success: true }));
	} catch (err) { next(err); }
});

// POST /api/discovery/promote/:slug
// Promotes an unmanaged device to managed by creating its LDAP groups.
router.post('/promote/:slug', async (req, res, next) => {
	try {
		const resource = await Resource.getBySlug(req.params.slug);
		if (!resource) return res.status(404).json(envelope({ error: 'Not found' }));
		
		// Groups come from services/resource_groups.js, the same path a resource
		// created through the Directory takes. This handler used to mint its own
		// `<slug>_access` / `<slug>_admin` pair at levels 'user' and 'admin' --
		// a naming scheme no consumer parses, and a level ('user') the access
		// model does not rank, so a promoted resource's access group granted
		// nothing and site admins could not reach it.
		const { groupKind, ensureSiteGroups, provisionResourceGroups } = require('../services/resource_groups');
		const groupsUtil = require('../utils/groups');

		// `Resource.update` is not a static — `update` is an instance method
		// (@simpleworkjs/orm). Load a fresh instance and call it on that.
		//
		// The new object matters as much as the fresh instance: handing the ORM
		// back the very object it already holds as `metadata` is not seen as a
		// change and the row is silently not written. This worked only because
		// the reload made it a different reference; spelling it out so it keeps
		// working if the reload ever goes away.
		const inst = await Resource.get(resource.id);
		await inst.update({ metadata: { ...(inst.metadata || {}), managed: true } });

		// Promotion is what makes a discovered row catalog content, so the
		// subtype's own rule about groups only applies from here.
		const gKind = groupKind(inst);
		let created = [];
		if (gKind) {
			const siteSlug = await Resource.findAncestorSiteSlug(inst.id).catch(() => null);
			if (!siteSlug) {
				return res.status(409).json(envelope({
					error: 'This resource has no site ancestor, so its groups cannot be named. Give it a parent first.'
				}));
			}
			await ensureSiteGroups(siteSlug, req.user.dn, siteSlug);
			await provisionResourceGroups(inst, gKind, siteSlug, req.user.dn);
			const nameSlug = groupsUtil.resourceNameSlug(inst.slug);
			created = [
				groupsUtil.resourceGroupCns(siteSlug, gKind, nameSlug, 'access'),
				groupsUtil.resourceGroupCns(siteSlug, gKind, nameSlug, 'admin')
			];
		}

		res.json(envelope({ success: true, groups: created }));
	} catch (err) { next(err); }
});

module.exports = router;
