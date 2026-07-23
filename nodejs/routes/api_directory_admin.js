'use strict';
const router = require('express').Router();
const permission = require('../utils/permission');
const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { Group } = require('../models/group_ldap');

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
    const resources = await Resource.list();
    res.json({ results: resources });
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
    
    let r;
    if (req.body.kind === 'oauth') {
      const { OAuthClient } = require('../models/oauth_client');
      // Pass created_by explicitly for the wrapper
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
      const createGroup = async (suffix, accessLevel) => {
        const cn = `${r.slug}_${suffix}`;
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
    let r;
    if (req.body.kind === 'oauth') {
        const { OAuthClient } = require('../models/oauth_client');
        r = await OAuthClient.get(req.params.id);
    } else {
        r = await Resource.get(req.params.id);
    }
    if (!r) return res.status(404).json({ error: 'Not found' });
    
    if (req.body.kind === 'host' && !req.body.hostId) {
      return res.status(400).json({ error: 'Hosts must have a parent Site or Host' });
    }
    if (req.body.kind === 'service' && !req.body.hostId) {
      return res.status(400).json({ error: 'Services must have a parent Host' });
    }
    if (req.body.kind === 'oauth' && !req.body.hostId) {
      return res.status(400).json({ error: 'OAuth Integrations must have a parent Service' });
    }
    
    let updated;
    if (req.body.kind === 'oauth') {
        updated = await r.update(req.body);
    } else {
        updated = await r.update(req.body);
    }
    
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
    await r.delete();
    // Also delete edges and groups involving this resource
    const edgesParent = await ResourceEdge.list({ where: { parentId: req.params.id } });
    const edgesChild = await ResourceEdge.list({ where: { childId: req.params.id } });
    const groups = await ResourceGroup.list({ where: { resourceId: req.params.id } });
    for (const e of [...edgesParent, ...edgesChild]) await e.delete();
    for (const g of groups) await g.delete();
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

router.get('/audit-logs', async (req, res, next) => {
  try {
    const fs = require('fs');
    const { execSync } = require('child_process');
    let ldapLogs = '';
    let oauthLogs = '';
    let auditLogs = '';
    
    try { ldapLogs = execSync('tail -n 100 /var/lib/ldap/slapd.log 2>/dev/null').toString(); } catch(e){}
    try { oauthLogs = execSync('tail -n 100 /var/lib/ldap/oauth.log 2>/dev/null').toString(); } catch(e){}
    try { auditLogs = execSync('tail -n 100 /var/lib/ldap/auditlog.ldif 2>/dev/null').toString(); } catch(e){}
    
    res.json({ results: { ldap: ldapLogs, oauth: oauthLogs, audit: auditLogs } });
  } catch (err) { next(err); }
});

module.exports = router;
