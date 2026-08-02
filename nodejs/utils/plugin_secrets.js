'use strict';

// Per-instance plugin secrets, stored in OpenBao at `secret/plugins/<id>/conf`.
//
// Plugins run in-process (as BullMQ workers in the SSO Node process), so they
// need no OpenBao token of their own — the SSO reads/writes their secrets
// server-side through the `sso-broker` token (@simpleworkjs/bao-conf), exactly
// like it reads its own `secret/sso-manager/conf`. This mirrors the per-user
// (`secret/users/<uid>/*`) and per-app (`secret/apps/<name>/*`) namespaces.
//
// Only the configSchema fields flagged `secret:true` are stored here; the rest
// of an instance's config lives in the PluginInstance DB row. The admin UI
// only ever sees these masked (`********`).
//
// Requires theta-suite >= v1.30.1: the sso-broker policy must grant
// `secret/data/plugins/*` + `secret/metadata/plugins/*`. Without it, write/
// read fail with a 403 — the API surfaces that as a clear error so the operator
// knows to re-run `./setup.sh`.

const baoConf = require('@simpleworkjs/bao-conf');

// Instance ids are ORM-generated uuids, so this is defense-in-depth against a
// bogus id ever being interpolated into a secret path. 404s are expected
// (no secret written yet); other malformed input is rejected hard.
function assertId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    const err = new Error('invalid plugin instance id for secret path');
    err.status = 400;
    throw err;
  }
}

function path(id) {
  return `plugins/${id}/conf`; // baoConf.get/set add the secret/data prefix
}

// Read the secret field values for an instance. Returns {} when none are
// stored yet (a brand-new instance, or one with no secret fields). A 404 from
// OpenBao is normal — anything else propagates.
async function read(id) {
  assertId(id);
  try {
    const data = await baoConf.get(path(id));
    return (data && typeof data === 'object') ? data : {};
  } catch (err) {
    // bao-conf treats a missing KV path as null/empty, but a 403 means the
    // sso-broker policy lacks secret/plugins/* — surface that distinctly.
    if (err && /403|permission/i.test(err.message)) throw err;
    return {};
  }
}

// Write (replace) the secret field values for an instance. `secrets` is a flat
// {field: value} object of only the secret configSchema fields. Empty/blank
// values are dropped so we never store a masked placeholder back as a secret.
async function write(id, secrets) {
  assertId(id);
  const clean = {};
  for (const [k, v] of Object.entries(secrets || {})) {
    if (v === undefined || v === null || v === '' || v === '********') continue;
    clean[k] = v;
  }
  await baoConf.set(path(id), clean);
}

// Merge the stored secret field values over the instance's non-secret config,
// producing the single `config` object the plugin's run()/validate() receive.
// Non-secret values come from the DB row; secret values come from OpenBao.
async function mergeForRun(instance) {
  if (!instance) return {};
  const config = (instance.config && typeof instance.config === 'object') ? instance.config : {};
  const secrets = await read(instance.id);
  return { ...config, ...secrets };
}

// Best-effort delete of the instance's secret namespace. Called when an
// instance is deleted. A 404 (already gone / never written) is fine; anything
// else is logged and swallowed so a stuck OpenBao can't strand an instance row.
async function remove(id) {
  assertId(id);
  try {
    const res = await baoConf.request('DELETE', `secret/metadata/plugins/${id}/conf`);
    if (res && res.status && res.status !== 404 && !res.ok) {
      console.error(`[plugin_secrets] delete for ${id} returned ${res.status}`);
    }
  } catch (err) {
    console.error(`[plugin_secrets] failed to delete secrets for ${id}:`, err.message);
  }
}

module.exports = { read, write, remove, mergeForRun };