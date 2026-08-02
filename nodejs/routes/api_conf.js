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

// Secret fields stored inside secret/sso-manager/conf. These are NEVER returned
// in cleartext by GET /api/conf (masked to MASK below) and, on save, a blank or
// mask-valued submission preserves the stored value so an admin editing an
// unrelated field (e.g. the From address) doesn't have to re-enter — or leak —
// the SMTP password / OAuth JWT secret. Mirrors the plugin-secrets discipline.
const MASK = '********';
const SECRET_PATHS = [
	['smtp', 'pass'],
	['oauth', 'jwtSecret'],
	['voipms', 'password'],
];

function maskSecrets(obj) {
	const out = JSON.parse(JSON.stringify(obj));
	for (const [grp, key] of SECRET_PATHS) {
		if (out[grp] && out[grp][key]) out[grp][key] = MASK;
	}
	return out;
}

router.get('/', async (req, res) => {
  const editable = maskSecrets({
    smtp: conf.smtp || {},
    discovery: conf.discovery || {},
    oauth: conf.oauth || {},
    voipms: conf.voipms || {}
  });
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
    const incoming = req.body || {};

    // Preserve secret fields the admin left blank (or left showing the mask):
    // drop them from the incoming merge so the stored value survives. Only a
    // genuinely new, non-blank, non-mask value overwrites.
    for (const [grp, key] of SECRET_PATHS) {
      if (incoming[grp] && incoming[grp][key] !== undefined) {
        const submitted = incoming[grp][key];
        if (submitted === '' || submitted === MASK) delete incoming[grp][key];
      }
    }

    // Deep merge incoming into existing
    for (const key of Object.keys(incoming)) {
      if (typeof incoming[key] === 'object' && incoming[key] !== null && !Array.isArray(incoming[key])) {
        existing[key] = { ...(existing[key] || {}), ...incoming[key] };
      } else {
        existing[key] = incoming[key];
      }
    }
    await baoConf.set('sso-manager/conf', existing);
    // Reflect the saved values in the live conf immediately (the next boot's
    // bao-conf.init() would pick them up too, but this keeps running readers
    // current without a restart, as the old conf_manager did). `existing`
    // carries the preserved secret values, so live conf keeps them too.
    applyToLiveConf(existing);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});
router.get('/proxy', async (req, res, next) => {
  try {
    const proxyConf = await baoConf.get('proxy/conf') || {};
    const editable = JSON.parse(JSON.stringify(proxyConf));
    if (editable.oidc && editable.oidc.clientSecret) editable.oidc.clientSecret = MASK;
    if (editable.ldap && editable.ldap.bindPassword) editable.ldap.bindPassword = MASK;
    res.json(editable);
  } catch(err) {
    next(err);
  }
});

router.post('/proxy', async (req, res, next) => {
  try {
    const existing = await baoConf.get('proxy/conf') || {};
    const incoming = req.body || {};

    if (incoming.oidc && incoming.oidc.clientSecret !== undefined) {
      if (incoming.oidc.clientSecret === '' || incoming.oidc.clientSecret === MASK) delete incoming.oidc.clientSecret;
    }
    if (incoming.ldap && incoming.ldap.bindPassword !== undefined) {
      if (incoming.ldap.bindPassword === '' || incoming.ldap.bindPassword === MASK) delete incoming.ldap.bindPassword;
    }

    for (const key of Object.keys(incoming)) {
      if (typeof incoming[key] === 'object' && incoming[key] !== null && !Array.isArray(incoming[key])) {
        existing[key] = { ...(existing[key] || {}), ...incoming[key] };
      } else {
        existing[key] = incoming[key];
      }
    }
    await baoConf.set('proxy/conf', existing);
    res.json({ success: true });
  } catch(err) {
    next(err);
  }
});

module.exports = router;