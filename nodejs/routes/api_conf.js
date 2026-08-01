const router = require('express').Router();
const baoConf = require('@simpleworkjs/bao-conf');
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

// Shallow-per-key merge of `src` into the live conf object (matches the old
// conf_manager.applyConf behaviour: nested objects are spread, not deep-merged,
// so call-time conf readers see saved values without a restart).
function applyToLiveConf(src) {
  if (!src) return;
  for (const key of Object.keys(src)) {
    if (typeof src[key] === 'object' && src[key] !== null && !Array.isArray(src[key])) {
      conf[key] = { ...(conf[key] || {}), ...src[key] };
    } else {
      conf[key] = src[key];
    }
  }
}

router.post('/', async (req, res, next) => {
  try {
    const existing = await baoConf.get('sso-manager/conf') || {};
    // Deep merge req.body into existing
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'object' && req.body[key] !== null && !Array.isArray(req.body[key])) {
        existing[key] = { ...(existing[key] || {}), ...req.body[key] };
      } else {
        existing[key] = req.body[key];
      }
    }
    await baoConf.set('sso-manager/conf', existing);
    // Reflect the saved values in the live conf immediately (the next boot's
    // bao-conf.init() would pick them up too, but this keeps running readers
    // current without a restart, as the old conf_manager did).
    applyToLiveConf(existing);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

module.exports = router;