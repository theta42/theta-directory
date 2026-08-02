'use strict';

// Plugin type registry.
//
// A **plugin type** is a module under nodejs/plugins/<category>/<type>.js
// exporting a manifest:
//
//   { type, category, name, description, configSchema[], validate(), run() }
//
// `configSchema` is an array of field descriptors that drive the admin UI form
// and API validation. Fields with `secret: true` are stored in OpenBao
// (secret/plugins/<instance-id>/conf via utils/plugin_secrets.js); all other
// field values live in the PluginInstance DB row's `config` JSON column.
//
// `run(cfg)` does the work; the discovery plugins keep their historical
// `discover(cfg)` name and add `run` as an alias (the loader uses `run`).
//
// A **plugin instance** (models/plugin_instance.js) is a configured, loadable
// copy of a type — you can have several of the same type. This registry only
// knows about *types*; instances live in the DB.
//
// The scan happens once at require time (the set of installed .js files does
// not change without a redeploy). Runtime load/unload is per-instance, not
// per-type — adding a new plugin type still needs a restart.

const fs = require('fs');
const path = require('path');

const pluginsRoot = path.join(__dirname, '../plugins');
const MASK = '********';

// type -> module. Built once.
const _modules = new Map();
// type -> manifest summary (a safe, serializable subset for the UI/API).
const _summaries = [];

function loadAll() {
  _modules.clear();
  _summaries.length = 0;
  if (!fs.existsSync(pluginsRoot)) return;
  for (const category of fs.readdirSync(pluginsRoot)) {
    const catDir = path.join(pluginsRoot, category);
    const stat = fs.statSync(catDir);
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(catDir)) {
      if (!file.endsWith('.js')) continue;
      const type = path.basename(file, '.js');
      // require fresh-ish: a plugin file should be idempotent to load. Clear
      // from the cache so a future re-scan (e.g. in tests) picks up edits.
      const full = path.join(catDir, file);
      delete require.cache[require.resolve(full)];
      const mod = require(full);
      // Backfill manifest defaults so older plugins (only exporting discover)
      // still register with a usable summary.
      const manifest = {
        type: mod.type || type,
        category: mod.category || category,
        name: mod.name || type,
        description: mod.description || '',
        configSchema: Array.isArray(mod.configSchema) ? mod.configSchema : [],
        validate: typeof mod.validate === 'function' ? mod.validate : null,
        run: typeof mod.run === 'function' ? mod.run
          : typeof mod.discover === 'function' ? mod.discover : null
      };
      _modules.set(manifest.type, { mod, manifest });
      _summaries.push({
        type: manifest.type,
        category: manifest.category,
        name: manifest.name,
        description: manifest.description,
        configSchema: manifest.configSchema
      });
    }
  }
}

loadAll();

// All registered plugin types, as serializable summaries (no functions).
// Used by GET /api/plugins/types to build the "New Plugin" picker + form.
function getTypes() {
  return _summaries.map(s => ({ ...s }));
}

// The raw module for a type (has run/validate/discover). Throws if unknown.
function getModule(type) {
  const entry = _modules.get(type);
  if (!entry) {
    const err = new Error(`Unknown plugin type: ${type}`);
    err.status = 400;
    throw err;
  }
  return entry.mod;
}

// The manifest summary for a type. Returns null if unknown (callers gate on
// this to validate a pluginType before creating an instance).
function getManifest(type) {
  const entry = _modules.get(type);
  return entry ? entry.manifest : null;
}

// Keys of the secret fields in a type's configSchema.
function secretKeys(type) {
  const m = getManifest(type);
  if (!m) return [];
  return m.configSchema.filter(f => f.secret).map(f => f.key);
}

// Non-secret field keys in a type's configSchema.
function publicKeys(type) {
  const m = getManifest(type);
  if (!m) return [];
  return m.configSchema.filter(f => !f.secret).map(f => f.key);
}

// All declared field keys (secret + non-secret) — for required-field validation.
function fieldKeys(type) {
  const m = getManifest(type);
  if (!m) return [];
  return m.configSchema.map(f => f.key);
}

// Required field keys.
function requiredKeys(type) {
  const m = getManifest(type);
  if (!m) return [];
  return m.configSchema.filter(f => f.required).map(f => f.key);
}

// Replace each present secret value with MASK, keeping the keys so the UI can
// render a prefilled (masked) password field. Non-secret values are passed
// through unchanged. `values` is a plain object of field->value.
function mask(type, values) {
  if (!values || typeof values !== 'object') return values;
  const sk = new Set(secretKeys(type));
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = sk.has(k) && v ? MASK : v;
  }
  return out;
}

// Split a flat {field: value} object (as the UI/API sends it) into non-secret
// config (for the DB row) and secret values (for OpenBao). Unknown keys are
// dropped — only declared configSchema fields are kept.
function splitConfig(type, flat) {
  const manifest = getManifest(type);
  const config = {};
  const secrets = {};
  if (!manifest || !flat) return { config, secrets };
  for (const f of manifest.configSchema) {
    if (!(f.key in flat)) continue;
    if (f.secret) secrets[f.key] = flat[f.key];
    else config[f.key] = flat[f.key];
  }
  return { config, secrets };
}

module.exports = {
  getTypes,
  getModule,
  getManifest,
  secretKeys,
  publicKeys,
  fieldKeys,
  requiredKeys,
  mask,
  splitConfig,
  // for tests
  _reload: loadAll
};