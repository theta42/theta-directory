'use strict';

// Discovery / plugin scheduler.
//
// Generalized from the one-shot discovery-plugin loader: plugin *types* live
// under nodejs/plugins/<category>/<type>.js (see services/plugin_registry.js),
// and configured, loadable/unloadable *instances* live in the PluginInstance
// table (models/plugin_instance.js). This module schedules enabled instances
// on cron via BullMQ JobSchedulers and runs them in a Worker.
//
// Each instance owns a stable JobScheduler id (`plugin:<instanceId>`) so load/
// unload can add/remove a single schedule without disturbing the others —
// `upsertJobScheduler`/`removeJobScheduler` (BullMQ v6) take that id directly.
//
// Per-instance secrets are merged in from OpenBao (utils/plugin_secrets.js) at
// run time; the plugin's run()/discover() receives the combined non-secret
// config + secret values as a single `config` object, exactly as the legacy
// static-config path did.

const { Queue, Worker } = require('bullmq');
const { DiscoveryReconciler } = require('./discovery_reconciler');
const pluginRegistry = require('./plugin_registry');
const pluginSecrets = require('../utils/plugin_secrets');
const { PluginInstance, STATUS } = require('../models/plugin_instance');
const Redis = require('ioredis');

// Ensure Redis connection works for BullMQ
const redisOpts = { maxRetriesPerRequest: null };
const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', redisOpts);

const discoveryQueue = new Queue('discovery', { connection });

const RUN = 'run_plugin';
const GC = 'garbage_collect';
function pluginSchedulerId(id) { return `plugin:${id}`; }

const worker = new Worker('discovery', async job => {
  if (job.name === RUN) {
    await runPluginJob(job.data && job.data.instanceId);
  } else if (job.name === GC) {
    console.log('[Scheduler] Running garbage collection');
    await DiscoveryReconciler.garbageCollect();
  }
}, { connection });

// Run one plugin instance. Loads the row (skip silently if it was deleted or
// disabled after the job was enqueued), merges its OpenBao secrets into its
// config, calls the plugin's run()/discover(), and — for discovery plugins —
// reconciles the result into the resource graph under the instance's slug.
// Bookkeeping (lastRunAt/lastStatus/lastError) is stamped on the row so the UI
// can show run state without querying BullMQ.
async function runPluginJob(instanceId) {
  if (!instanceId) { console.warn('[Scheduler] run_plugin job with no instanceId'); return; }
  const instance = await PluginInstance.get(instanceId);
  if (!instance) { console.warn(`[Scheduler] instance ${instanceId} gone — skipping`); return; }
  if (!instance.enabled) { console.warn(`[Scheduler] instance ${instance.slug} (${instanceId}) disabled — skipping`); return; }

  let mod;
  try { mod = pluginRegistry.getModule(instance.pluginType); }
  catch (err) {
    console.error(`[Scheduler] instance ${instance.slug}: type ${instance.pluginType} unavailable:`, err.message);
    await instance.update({ lastRunAt: Date.now(), lastStatus: STATUS.ERROR, lastError: `plugin type unavailable: ${instance.pluginType}` });
    return;
  }

  const runFn = mod.run || mod.discover;
  if (typeof runFn !== 'function') {
    console.error(`[Scheduler] instance ${instance.slug}: type ${instance.pluginType} has no run()/discover()`);
    await instance.update({ lastRunAt: Date.now(), lastStatus: STATUS.ERROR, lastError: 'plugin type has no run()/discover()' });
    return;
  }

  console.log(`[Scheduler] Running plugin: ${instance.slug} (${instance.pluginType})`);
  await instance.update({ lastRunAt: Date.now(), lastStatus: STATUS.RUNNING, lastError: null, lastLog: null });
  let logs = [];
  try {
    const cfg = await pluginSecrets.mergeForRun(instance);
    cfg.log = (msg) => {
      logs.push(`[${new Date().toISOString()}] ${msg}`);
      console.log(`[Plugin ${instance.slug}] ${msg}`);
      if (logs.length > 1000) logs.shift();
    };
    const payload = await runFn(cfg);
    if (instance.category === 'discovery') {
      await DiscoveryReconciler.reconcile(instance.slug, payload);
    }
    await instance.update({ lastStatus: STATUS.OK, lastError: null, lastLog: logs.join('\n') });
  } catch (err) {
    console.error(`[Scheduler] Plugin ${instance.slug} failed:`, err.message);
    await instance.update({ lastStatus: STATUS.ERROR, lastError: String(err.message || err), lastLog: logs.join('\n') });
  }
}

// Schedule one instance: upsert a repeatable JobScheduler keyed by its id. Does
// NOT trigger an immediate run — call runInstanceNow(id) separately for that
// (used on boot and on "load"). Safe to call repeatedly (upsert is idempotent
// and will update the cron if it changed).
async function scheduleInstance(instance) {
  if (!instance || !instance.id) return;
  if (!instance.enabled) { await unscheduleInstance(instance.id); return; }
  const cron = instance.cron || '0 * * * *';
  await discoveryQueue.upsertJobScheduler(pluginSchedulerId(instance.id), { pattern: cron }, {
    name: RUN,
    data: { instanceId: instance.id }
  });
  console.log(`[Scheduler] Scheduled instance ${instance.slug} with cron ${cron}`);
}

// Remove an instance's repeatable schedule. No-op if it had none.
async function unscheduleInstance(id) {
  if (!id) return;
  try { await discoveryQueue.removeJobScheduler(pluginSchedulerId(id)); }
  catch (err) { /* missing scheduler is fine */ }
}

// Enqueue a single immediate run for an instance (the "Run now" button / boot
// kick). Runs once regardless of enabled, on top of any schedule.
async function runInstanceNow(id) {
  if (!id) return;
  await discoveryQueue.add(RUN, { instanceId: id });
}

// One-time legacy migration: if the PluginInstance table is empty AND
// conf.discovery.plugins has entries (the old static-config shape), seed one
// instance per configured type and copy its secret fields into OpenBao. After
// the first boot, the table is non-empty and the static config is ignored.
// Idempotent (guarded by the empty-table check).
async function migrateLegacyPlugins(discoveryConfig) {
  const existing = await PluginInstance.list();
  if (existing && existing.length) return;

  const legacy = discoveryConfig && discoveryConfig.plugins;
  if (!legacy || typeof legacy !== 'object') return;
  const names = Object.keys(legacy);
  if (!names.length) return;

  console.log(`[Scheduler] Migrating ${names.length} legacy discovery plugin(s) to instances…`);
  for (const name of names) {
    const entry = legacy[name] || {};
    const manifest = pluginRegistry.getManifest(name);
    if (!manifest) {
      console.warn(`[Scheduler] legacy plugin '${name}' has no registered type — skipping`);
      continue;
    }
    // splitConfig keeps only declared configSchema fields and separates secret
    // from non-secret. Legacy `enabled`/`cron` are not in configSchema, so they
    // are dropped here and read from the entry directly below.
    const { config, secrets } = pluginRegistry.splitConfig(name, entry);
    const instance = await PluginInstance.create({
      pluginType: name,
      category: manifest.category,
      name: manifest.name,
      slug: name,
      enabled: entry.enabled !== false,
      cron: entry.cron || '0 * * * *',
      config,
      created_by: 'legacy-migration'
    });
    try {
      await pluginSecrets.write(instance.id, secrets);
      console.log(`[Scheduler] migrated '${name}' -> instance ${instance.id} (slug ${instance.slug})`);
    } catch (err) {
      // The instance row exists; if we can't write secrets (e.g. the sso-broker
      // policy predates theta-suite v1.30.1) the operator gets a clear error
      // from the API on edit, and the instance still runs with its non-secret
      // config. Don't delete the row — the operator just needs to re-run
      // setup.sh and edit/save the secrets.
      console.error(`[Scheduler] migrated '${name}' row but FAILED to write secrets:`, err.message);
      await instance.update({ lastStatus: STATUS.ERROR, lastError: `secret migration failed: ${err.message}` });
    }
  }
}

// Boot-time initialization: clear stale schedulers, schedule garbage collection,
// migrate any legacy static-config plugins, then schedule every enabled
// instance and kick one immediate run for each.
async function initScheduler(discoveryConfig) {
  // Clear stale plugin/gc schedulers from a previous boot. Other-named
  // schedulers (none in this app) are left alone.
  try {
    const schedulers = await discoveryQueue.getJobSchedulers();
    for (const s of schedulers) {
      if (s.name === RUN || s.name === GC) {
        await discoveryQueue.removeJobScheduler(s.key || s.id);
      }
    }
  } catch (e) {
    console.log('[Scheduler] Could not clear old job schedulers:', e.message);
  }

  // Daily garbage collection of stale discovery resources.
  await discoveryQueue.upsertJobScheduler(GC, { pattern: '0 0 * * *' }, { name: GC, data: {} });

  try {
    await migrateLegacyPlugins(discoveryConfig);
  } catch (err) {
    console.error('[Scheduler] legacy migration failed:', err.message);
  }

  const enabled = await PluginInstance.listEnabled();
  for (const instance of enabled) {
    await scheduleInstance(instance);
    await runInstanceNow(instance.id); // boot kick
  }
  console.log(`[Scheduler] initialized — ${enabled.length} instance(s) scheduled`);
}

module.exports = {
  initScheduler,
  scheduleInstance,
  unscheduleInstance,
  runInstanceNow,
  discoveryQueue,
  connection
};