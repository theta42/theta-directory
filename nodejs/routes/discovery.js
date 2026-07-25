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

const router = require('express').Router();
const { Resource, ResourceGroup } = require('../models/resource');
const {
	envelope,
	projectResource,
	projectResources,
	isDirectoryAdmin,
} = require('@simpleworkjs/directory-schema');

// GET /api/discovery/resources[?kind=&group=&parent=]
router.get('/resources', async (req, res, next) => {
	try {
		const resources = await Resource.search(req.query);
		res.json(envelope(projectResources(resources, { fullMetadata: isDirectoryAdmin(req.user) })));
	} catch (err) { next(err); }
});

// GET /api/discovery/resources/:slug
router.get('/resources/:slug', async (req, res, next) => {
	try {
		const resource = await Resource.getBySlug(req.params.slug);
		// parents/children are edges (no secrets); project only the resource body.
		const projected = projectResource(resource, { fullMetadata: isDirectoryAdmin(req.user) });
		projected.parents = resource.parents;
		projected.children = resource.children;
		res.json(envelope(projected));
	} catch (err) { next(err); }
});

// GET /api/discovery/graph
router.get('/graph', async (req, res, next) => {
	try {
		const graph = await Resource.getGraph();
		res.json(envelope({
			resources: projectResources(graph.resources, { fullMetadata: isDirectoryAdmin(req.user) }),
			edges: graph.edges,
		}));
	} catch (err) { next(err); }
});

// GET /api/discovery/me
// Returns the resources the current caller can reach. Machines see only their
// own resource; humans get the union of their LDAP groups' resources plus
// anything flagged isPublic. Uses req.user.groups (populated by the auth
// middleware for session/PAT callers) rather than re-querying LDAP by DN, so it
// works for every auth transport without assuming a .dn is present.
router.get('/me', async (req, res, next) => {
	try {
		let accessible;
		if (req.user && req.user.isMachine) {
			accessible = await Resource.list({ where: { id: req.resourceId } });
		} else {
			const userGroups = (req.user && req.user.groups) || [];
			const ids = new Set();
			if (userGroups.length) {
				const rgs = await ResourceGroup.list({ where: { groupCn: { in: userGroups } } });
				for (const rg of rgs) ids.add(rg.resourceId);
			}
			const all = await Resource.list();
			accessible = all.filter(r => ids.has(r.id) || (r.metadata && r.metadata.isPublic));
		}
		res.json(envelope(projectResources(accessible, { fullMetadata: isDirectoryAdmin(req.user) })));
	} catch (err) { next(err); }
});

module.exports = router;