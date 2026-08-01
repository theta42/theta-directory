const { Queue, Worker } = require('bullmq');
const { DiscoveryReconciler } = require('./discovery_reconciler');
const Redis = require('ioredis');

// Ensure Redis connection works for BullMQ
const redisOpts = { maxRetriesPerRequest: null };
const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', redisOpts);

const discoveryQueue = new Queue('discovery', { connection });

// Load plugins
const fs = require('fs');
const path = require('path');
const pluginsDir = path.join(__dirname, '../plugins/discovery');

let plugins = {};

if (fs.existsSync(pluginsDir)) {
  fs.readdirSync(pluginsDir).forEach(file => {
    if (file.endsWith('.js')) {
      const name = path.basename(file, '.js');
      plugins[name] = require(path.join(pluginsDir, file));
    }
  });
}

const worker = new Worker('discovery', async job => {
  if (job.name === 'run_plugin') {
    const { pluginName, config } = job.data;
    if (plugins[pluginName]) {
      console.log(`[Scheduler] Running plugin: ${pluginName}`);
      try {
        const payload = await plugins[pluginName].discover(config);
        await DiscoveryReconciler.reconcile(pluginName, payload);
      } catch (err) {
        console.error(`[Scheduler] Plugin ${pluginName} failed:`, err);
      }
    }
  } else if (job.name === 'garbage_collect') {
    console.log(`[Scheduler] Running garbage collection`);
    await DiscoveryReconciler.garbageCollect();
  }
}, { connection });

// Function to start scheduling
async function initScheduler(discoveryConfig) {
  // Clear old repeatable jobs (BullMQ v6 uses JobSchedulers)
  try {
    const schedulers = await discoveryQueue.getJobSchedulers();
    for (const job of schedulers) {
      await discoveryQueue.removeJobScheduler(job.id);
    }
  } catch (e) {
    console.log('[Scheduler] Could not clear old job schedulers (may not be supported or none exist)');
  }

  // Schedule Garbage Collection
  await discoveryQueue.add('garbage_collect', {}, { repeat: { pattern: '0 0 * * *' } }); // Daily

  // Load plugin overrides from Redis
  let overrides = {};
  try {
    const data = await connection.hgetall('discovery_plugins');
    for (const [k, v] of Object.entries(data)) {
      overrides[k] = JSON.parse(v);
    }
  } catch (err) {
    console.error('[Scheduler] Failed to load plugin overrides from Redis', err);
  }

  // Schedule Plugins based on config + overrides
  if (discoveryConfig && discoveryConfig.plugins) {
    for (const [name, config] of Object.entries(discoveryConfig.plugins)) {
      const mergedConfig = { ...config, ...(overrides[name] || {}) };
      if (mergedConfig.enabled && plugins[name]) {
        const cron = mergedConfig.cron || '0 * * * *'; // Default hourly
        await discoveryQueue.add('run_plugin', { pluginName: name, config: mergedConfig }, { repeat: { pattern: cron } });
        console.log(`[Scheduler] Scheduled plugin ${name} with cron ${cron}`);
        
        // Also run once immediately
        await discoveryQueue.add('run_plugin', { pluginName: name, config: mergedConfig });
      }
    }
  }
}

module.exports = { initScheduler, discoveryQueue, connection };
