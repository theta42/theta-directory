const router = require('express').Router();
const permission = require('../utils/permission');

router.use(async (req, res, next) => {
  try {
    await permission.byGroup(req.user, ['app_sso_admin']);
    next();
  } catch(err) {
    next(err);
  }
});

router.get('/', (req, res) => {
  res.render('conf', {
    title: 'Configuration',
    user: req.user
  });
});

module.exports = router;
