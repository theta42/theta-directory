const router = require('express').Router();
const conf = require('@simpleworkjs/conf');
const permission = require('../utils/permission');

router.use(async (req, res, next) => {
  try {
    await permission.byGroup(req.user, ['app_sso_directory_admin', 'app_sso_admin']);
    next();
  } catch(err) {
    next(err);
  }
});

const Redis = require('ioredis');
const connection = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
const { initScheduler } = require('../services/scheduler');

router.get('/', async (req, res) => {
  const plugins = conf.discovery && conf.discovery.plugins ? conf.discovery.plugins : {};
  let overrides = {};
  try {
    const data = await connection.hgetall('discovery_plugins');
    for (const [k, v] of Object.entries(data)) {
      overrides[k] = JSON.parse(v);
    }
  } catch(e) {}
  
  // Mask secrets before sending
  const masked = JSON.parse(JSON.stringify(plugins));
  for (const name in masked) {
    masked[name] = { ...masked[name], ...(overrides[name] || {}) };
    if (masked[name].tokenSecret) masked[name].tokenSecret = '********';
    if (masked[name].password) masked[name].password = '********';
  }
  res.json({ results: masked });
});

router.put('/:name', async (req, res) => {
  const name = req.params.name;
  const updates = req.body;
  
  let current = {};
  try {
    const data = await connection.hget('discovery_plugins', name);
    if (data) current = JSON.parse(data);
  } catch(e) {}
  
  if (updates.cron !== undefined) current.cron = updates.cron;
  if (updates.enabled !== undefined) current.enabled = updates.enabled === true || updates.enabled === 'true';
  
  await connection.hset('discovery_plugins', name, JSON.stringify(current));
  
  // Re-init scheduler to apply changes
  await initScheduler(conf.discovery).catch(console.error);
  
  res.json({ success: true, message: 'Plugin updated' });
});

module.exports = router;
