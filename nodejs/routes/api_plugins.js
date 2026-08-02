'use strict';

// Plugin instances API — the loadable, configurable, multi-copy plugin system.
//
// Replaces the old routes/plugins.js (which only toggled cron/enabled on static
// config via a Redis hash). Here every plugin is a PluginInstance row (see
// models/plugin_instance.js) with its own schedule and its secrets in OpenBao
// (utils/plugin_secrets.js), created/edited/loaded/unloaded through this API.
//
// Gated router-wide to the same admin groups as the directory admin API, so
// existing directory admins keep access. Secrets are never returned in
// cleartext — only masked (`********`) — and never persisted in the DB.

const router = require('express').Router();
const permission = require('../utils/permission');
const registry = require('../services/plugin_registry');
const pluginSecrets = require('../utils/plugin_secrets');
const { PluginInstance, STATUS } = require('../models/plugin_instance');
const { scheduleInstance, unscheduleInstance, runInstanceNow } = require('../services/scheduler');

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// Derive a stable, unique slug from an instance name when the caller didn't
// supply one. Lowercases, collapses non-alnum runs to a single hyphen, trims,
// and prefixes `plugin-` if the result would otherwise start with a character
// SLUG_RE rejects. `isTaken(slug)` is consulted for uniqueness (a DB lookup);
// on collision we append `-2`, `-3`, … up to MAX_TRIES, then give up.
function slugify(name) {
  let s = String(name || '').toLowerCase().trim();
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!s) s = 'plugin';
  if (!/^[a-z0-9]/.test(s)) s = 'plugin-' + s;
  return s.slice(0, 64);
}

async function makeSlug(name, isTaken) {
  const base = slugify(name);
  if (!await isTaken(base)) return base;
  for (let i = 2; i <= 16; i++) {
    const cand = `${base}-${i}`.slice(0, 64);
    if (!await isTaken(cand)) return cand;
  }
  return null; // exhausted
}

// Same gate as the directory admin API: app_sso_admin or app_sso_directory_admin
// (app_super_admin is always allowed by permission.byGroup).
router.use(async (req, res, next) => {
  try {
    await permission.byGroup(req.user, ['app_sso_directory_admin', 'app_sso_admin']);
    next();
  } catch (err) { next(err); }
});

// Plain object for the wire, with masked secret values attached under
// `secrets` and the run-state fields surfaced. The DB row never holds secrets.
async function serialize(instance) {
  const obj = instance.toJSON ? instance.toJSON() : { ...instance };
  const secrets = await pluginSecrets.read(instance.id).catch(() => ({}));
  obj.secrets = registry.mask(instance.pluginType, secrets);
  return obj;
}

// Validate a create/update payload against a plugin type's configSchema.
// Returns an error string or null. `flat` is the merged config + secret values
// (the UI sends one flat object; the API splits it).
function validateFields(type, flat) {
  const required = registry.requiredKeys(type);
  for (const key of required) {
    const v = flat && flat[key];
    if (v === undefined || v === null || v === '') {
      return `Missing required field: ${key}`;
    }
  }
  return null;
}

// --- Plugin types (for the create-instance picker + form) ---
router.get('/types', (req, res) => {
  res.json({ results: registry.getTypes() });
});

// --- List instances ---
router.get('/', async (req, res, next) => {
  try {
    const instances = await PluginInstance.list();
    const out = [];
    for (const inst of instances) out.push(await serialize(inst));
    res.json({ results: out });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    res.json({ results: await serialize(inst) });
  } catch (err) { next(err); }
});

// --- Create instance ---
router.post('/', async (req, res, next) => {
  try {
    const { pluginType, name, slug, cron } = req.body;
    if (!pluginType) return res.status(400).json({ error: 'pluginType is required' });
    if (!registry.getManifest(pluginType)) return res.status(400).json({ error: `Unknown plugin type: ${pluginType}` });
    if (!name) return res.status(400).json({ error: 'name is required' });
    // Slug is optional: derive it from the name when absent. When supplied,
    // validate it (admins editing via API may still pass one explicitly).
    let finalSlug = slug;
    if (finalSlug) {
      if (!SLUG_RE.test(finalSlug)) return res.status(400).json({ error: 'slug must be lowercase letters/digits/_/- (max 64)' });
    } else {
      finalSlug = await makeSlug(name, async (s) => !!(await PluginInstance.getBySlug(s)));
      if (!finalSlug) return res.status(400).json({ error: 'Could not generate a unique slug from the name; supply one explicitly.' });
    }
    if (cron !== undefined && (typeof cron !== 'string' || !cron.trim())) return res.status(400).json({ error: 'cron must be a non-empty string' });

    // `config` from the client is a flat object of all field values (secret +
    // non-secret). Split it: non-secret -> DB, secret -> OpenBao.
    const flat = (req.body.config && typeof req.body.config === 'object') ? req.body.config : {};
    const fieldErr = validateFields(pluginType, flat);
    if (fieldErr) return res.status(400).json({ error: fieldErr });

    const manifest = registry.getManifest(pluginType);
    const { config, secrets } = registry.splitConfig(pluginType, flat);
    const enabled = req.body.enabled !== false; // default true
    const now = Date.now();

    const instance = await PluginInstance.create({
      pluginType,
      category: manifest.category,
      name,
      slug: finalSlug,
      enabled,
      cron: cron || '0 * * * *',
      config,
      created_by: req.user.uid,
      created_on: now,
      updated_by: req.user.uid,
      updated_on: now
    });

    try {
      await pluginSecrets.write(instance.id, secrets);
    } catch (err) {
      // Most likely the sso-broker policy lacks secret/plugins/* — the
      // operator needs theta-suite >= v1.30.1. Delete the row so a failed
      // secret write doesn't strand a half-created instance.
      await instance.delete().catch(() => {});
      return res.status(400).json({ error: `Failed to store plugin secrets in OpenBao: ${err.message}. Re-run ./setup.sh with theta-suite >= v1.30.1.` });
    }

    if (enabled) {
      await scheduleInstance(instance);
      await runInstanceNow(instance.id);
    }
    res.json({ results: await serialize(instance) });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'A plugin instance with this slug already exists.' });
    }
    next(err);
  }
});

// --- Update instance (name/cron/enabled/non-secret config) ---
router.put('/:id', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    if (!registry.getManifest(inst.pluginType)) return res.status(400).json({ error: `Plugin type ${inst.pluginType} is no longer installed` });

    const updates = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.cron !== undefined) {
      if (typeof req.body.cron !== 'string' || !req.body.cron.trim()) return res.status(400).json({ error: 'cron must be a non-empty string' });
      updates.cron = req.body.cron;
    }
    if (req.body.enabled !== undefined) updates.enabled = !!req.body.enabled;

    // Non-secret config: split the client's flat config so secret fields are
    // never written to the DB. Secrets are changed via PUT /:id/secrets.
    if (req.body.config !== undefined && typeof req.body.config === 'object') {
      const { config } = registry.splitConfig(inst.pluginType, req.body.config);
      updates.config = config;
    }

    updates.updated_by = req.user.uid;
    updates.updated_on = Date.now();

    const updated = await inst.update(updates);

    // Re-schedule if the schedule-relevant fields moved.
    if (updates.cron !== undefined || updates.enabled !== undefined) {
      await scheduleInstance(updated);
    }
    res.json({ results: await serialize(updated) });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      return res.status(400).json({ error: 'A plugin instance with this slug already exists.' });
    }
    next(err);
  }
});

// --- Update secrets only ---
router.put('/:id/secrets', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    if (!registry.getManifest(inst.pluginType)) return res.status(400).json({ error: `Plugin type ${inst.pluginType} is no longer installed` });

    // Keep only declared secret fields; pluginSecrets.write drops blank/MASK
    // values so an unchanged masked field is a no-op.
    const { secrets } = registry.splitConfig(inst.pluginType, req.body || {});
    await pluginSecrets.write(inst.id, secrets);
    await inst.update({ updated_by: req.user.uid, updated_on: Date.now() });
    res.json({ results: true });
  } catch (err) { next(err); }
});

// --- Test (validate) ---
router.post('/:id/test', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    const mod = registry.getModule(inst.pluginType);
    if (typeof mod.validate !== 'function') return res.json({ ok: true, note: 'no validate defined' });
    const cfg = await pluginSecrets.mergeForRun(inst);
    const result = await mod.validate(cfg);
    if (result && result.ok) return res.json(result);
    return res.status(400).json(result || { ok: false, error: 'validation failed' });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// --- Load (enable + schedule + run now) ---
router.post('/:id/load', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    const updated = await inst.update({ enabled: true, updated_by: req.user.uid, updated_on: Date.now() });
    await scheduleInstance(updated);
    await runInstanceNow(updated.id);
    res.json({ results: await serialize(updated) });
  } catch (err) { next(err); }
});

// --- Unload (unschedule + disable) ---
router.post('/:id/unload', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    await unscheduleInstance(inst.id);
    const updated = await inst.update({ enabled: false, updated_by: req.user.uid, updated_on: Date.now() });
    res.json({ results: await serialize(updated) });
  } catch (err) { next(err); }
});

// --- Run now (regardless of enabled) ---
router.post('/:id/run', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    await runInstanceNow(inst.id);
    res.json({ results: true });
  } catch (err) { next(err); }
});

// --- Last-run status ---
router.get('/:id/runs', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    res.json({ results: { lastRunAt: inst.lastRunAt, lastStatus: inst.lastStatus, lastError: inst.lastError, lastLog: inst.lastLog } });
  } catch (err) { next(err); }
});

// --- Delete (unschedule + remove secrets + delete row) ---
router.delete('/:id', async (req, res, next) => {
  try {
    const inst = await PluginInstance.get(req.params.id);
    if (!inst) return res.status(404).json({ error: 'Not found' });
    await unscheduleInstance(inst.id);
    await pluginSecrets.remove(inst.id); // best-effort
    await inst.delete();
    res.json({ results: true });
  } catch (err) { next(err); }
});

module.exports = router;