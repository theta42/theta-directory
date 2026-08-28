'use strict';
const router = require('express').Router();
const permission = require('../utils/permission');
const { SubtypeTemplate } = require('../models/subtype_template');
const { replicateOnFinish } = require('../utils/replicate_on_finish');

// Only allow super admins or directory admins to manage subtype templates
const ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

router.use(async (req, res, next) => {
  try {
    if (req.method !== 'GET') {
      await permission.byGroup(req.user, ADMIN_GROUPS);
    }
    next();
  } catch (err) {
    if (err && (err.status === 401 || err.name === 'Insufficient Permission')) {
      return res.status(403).json({ status: 'error', message: 'admin only' });
    }
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const templates = await SubtypeTemplate.list();
    res.json({ status: 'ok', templates });
  } catch (err) { next(err); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const matches = await SubtypeTemplate.list({ where: { slug: req.params.slug } });
    const template = matches && matches[0];
    if (!template) return res.status(404).json({ status: 'error', message: 'Template not found' });
    res.json({ status: 'ok', template });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { slug, name, target_kind, schema, status_rules, icon } = req.body;
    if (!slug || !name || !target_kind) {
      return res.status(400).json({ status: 'error', message: 'slug, name, and target_kind are required' });
    }
    
    const existing = await SubtypeTemplate.list({ where: { slug } });
    if (existing && existing.length > 0) {
      return res.status(400).json({ status: 'error', message: 'A template with this slug already exists' });
    }

    const crypto = require('crypto');
    const created = await SubtypeTemplate.create({
      id: crypto.randomUUID(),
      slug, name, target_kind,
      schema: schema || {},
      status_rules: status_rules || [],
      icon: icon || '',
      created_on: Math.floor(Date.now() / 1000)
    });

    replicateOnFinish(res, 'subtype-template-created');
    res.json({ status: 'ok', template: created });
  } catch (err) { next(err); }
});

router.put('/:id', async (req, res, next) => {
  try {
    const template = await SubtypeTemplate.get(req.params.id);
    if (!template) return res.status(404).json({ status: 'error', message: 'Template not found' });

    const patch = {};
    if (req.body.name !== undefined) patch.name = req.body.name;
    if (req.body.target_kind !== undefined) patch.target_kind = req.body.target_kind;
    if (req.body.schema !== undefined) patch.schema = req.body.schema;
    if (req.body.status_rules !== undefined) patch.status_rules = req.body.status_rules;
    if (req.body.icon !== undefined) patch.icon = req.body.icon;
    
    patch.updated_on = Math.floor(Date.now() / 1000);

    const updated = await template.update(patch);
    replicateOnFinish(res, 'subtype-template-updated');
    res.json({ status: 'ok', template: updated });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const template = await SubtypeTemplate.get(req.params.id);
    if (!template) return res.status(404).json({ status: 'error', message: 'Template not found' });
    
    await template.delete();
    replicateOnFinish(res, 'subtype-template-deleted');
    res.json({ status: 'ok' });
  } catch (err) { next(err); }
});

module.exports = router;
