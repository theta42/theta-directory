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
    await confManager.setVaultConf(req.body);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

module.exports = router;
