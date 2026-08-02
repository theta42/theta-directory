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
			const ids = new Set();
			if (user.groups.length) {
				const rgs = await ResourceGroup.list({ where: { groupCn: { in: user.groups } } });
				for (const rg of rgs) ids.add(rg.resourceId);
			}
			const all = await Resource.list();
			accessible = all.filter(r => {
				const isAuto = r.metadata?.discovery_sources?.length > 0 && !r.metadata.discovery_sources.includes('manual');
				const isManaged = r.metadata?.managed === true;
				if (isAuto && !isManaged) return false;
				return ids.has(r.id) || (r.metadata && r.metadata.isPublic);
			});
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
router.get('/access/:uid/:slug?', async (req, res, next) => {
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
		const ids = new Set();
		if (groups.length) {
			const rgs = await ResourceGroup.list({ where: { groupCn: { in: groups } } });
			for (const rg of rgs) ids.add(rg.resourceId);
		}
		
		let all = await Resource.list();
		if (req.params.slug) all = all.filter(r => r.slug === req.params.slug);

		let accessible = all.filter(r => {
			const isAuto = r.metadata?.discovery_sources?.length > 0 && !r.metadata.discovery_sources.includes('manual');
			const isManaged = r.metadata?.managed === true;
			if (isAuto && !isManaged) return false;
			return ids.has(r.id) || (r.metadata && r.metadata.isPublic);
		});
		
		accessible = await Resource.withResolvedAddress(accessible);
		res.json(envelope(projectResources(accessible, { fullMetadata })));
	} catch (err) { next(err); }
});

// POST /api/discovery/sync
// Used by external agents (e.g. ldap-client) to push discovery data.
router.post('/sync', async (req, res, next) => {
	try {
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
		
		const { Group } = require('../models/group_ldap');
		
		const accessGroup = `${resource.slug}_access`;
		const adminGroup = `${resource.slug}_admin`;
		
		// Create groups if they don't exist
		try { await Group.get(accessGroup); } catch (e) {
			if (e.status === 404) await Group.add({ name: accessGroup, description: `Access to ${resource.name}`, owner: req.user.dn });
			else throw e;
		}
		try { await Group.get(adminGroup); } catch (e) {
			if (e.status === 404) await Group.add({ name: adminGroup, description: `Admin access to ${resource.name}`, owner: req.user.dn });
			else throw e;
		}
		
		// Link them
		const crypto = require('crypto');
		await ResourceGroup.create({
			id: crypto.randomUUID(),
			resourceId: resource.id,
			groupCn: accessGroup,
			accessLevel: 'user'
		});
		await ResourceGroup.create({
			id: crypto.randomUUID(),
			resourceId: resource.id,
			groupCn: adminGroup,
			accessLevel: 'admin'
		});
		
		const meta = resource.metadata || {};
		meta.managed = true;
		await resource.update({ metadata: meta });
		
		res.json(envelope({ success: true, groups: [accessGroup, adminGroup] }));
	} catch (err) { next(err); }
});

module.exports = router;
