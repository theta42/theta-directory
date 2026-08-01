const router = require('express').Router();
const confManager = require('../utils/conf_manager');
const permission = require('../utils/permission');
const conf = require('@simpleworkjs/conf');

router.use(async (req, res, next) => {
  try {
    await permission.byGroup(req.user, ['app_sso_admin']);
    next();
  } catch(err) {
    next(err);
  }
});

router.get('/', async (req, res) => {
  const editable = {
    smtp: conf.smtp || {},
    discovery: conf.discovery || {},
    oauth: conf.oauth || {}
  };
  res.json(editable);
});

router.post('/', async (req, res, next) => {
  try {
    const existing = await confManager.getVaultConf() || {};
    // Deep merge req.body into existing
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'object' && req.body[key] !== null && !Array.isArray(req.body[key])) {
        existing[key] = { ...(existing[key] || {}), ...req.body[key] };
      } else {
        existing[key] = req.body[key];
      }
    }
    await confManager.setVaultConf(existing);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

module.exports = router;
