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
const {
	envelope,
	projectResource,
	projectResources,
	isDirectoryAdmin,
} = require('@simpleworkjs/directory-schema');

// Resolve the caller's groups once per request and hand back the projection
// flag. Every handler needs both, and both are wrong if taken off req.user raw.
async function callerView(req) {
	const user = await withGroups(req.user);
	return { user, fullMetadata: isDirectoryAdmin(user) };
}

// GET /api/discovery/resources[?kind=&group=&parent=]
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
			const ids = new Set();
			if (user.groups.length) {
				const rgs = await ResourceGroup.list({ where: { groupCn: { in: user.groups } } });
				for (const rg of rgs) ids.add(rg.resourceId);
			}
			const all = await Resource.list();
			accessible = all.filter(r => ids.has(r.id) || (r.metadata && r.metadata.isPublic));
		}
		// resolvedAddress is the whole point of /me ("how do I reach it") and a
		// service inherits it from its host, so it must be computed here rather
		// than left to each caller to guess at address || ip.
		accessible = await Resource.withResolvedAddress(accessible);
		res.json(envelope(projectResources(accessible, { fullMetadata })));
	} catch (err) { next(err); }
});

module.exports = router;
