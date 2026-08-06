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

// Send a test email to verify SMTP configuration
router.post('/test-email', async (req, res, next) => {
  try {
    const { to, subject, body } = req.body || {};
    if (!to) {
      return res.status(400).json({ error: 'Recipient email address is required' });
    }

    // Send through the SAME sender every other feature uses (password reset,
    // invites, OTP-by-email, notifications). A "test" that reimplements
    // delivery proves nothing about whether real mail works.
    //
    // models/email.js exports `{Mail}`; requiring the module and calling
    // `.send` on it directly -- as this did -- always threw
    // "Email.send is not a function", so the button could never succeed.
    const { Mail } = require('../models/email');
    const testSubject = subject || 'SSO Manager Test Email';
    const testBody = body || `<p>This is a test email from SSO Manager.</p><p>If you received this, your SMTP configuration is working correctly.</p><p>Sent at: ${new Date().toISOString()}</p>`;

    await Mail.send(to, testSubject, testBody);
    res.json({ success: true, message: `Test email sent to ${to}` });
  } catch(err) {
    // A failed test is almost always a misconfiguration (wrong host, refused
    // connection, bad credentials) -- the operator's to fix, and something the
    // UI should be able to show them. Surfacing it as a 400 with the reason
    // beats an opaque 500 carrying a raw stack-trace name.
    return res.status(400).json({ error: err.message || 'Failed to send test email' });
  }
});

// Send a test SMS to verify VoIP.ms configuration
router.post('/test-sms', async (req, res, next) => {
  try {
    const { to, message } = req.body || {};
    if (!to) {
      return res.status(400).json({ error: 'Recipient phone number is required' });
    }

    // Send through models/sms.js -- the same path every real SMS takes. It
    // prefers a configured messaging plugin and falls back to VoIP.ms, and it
    // normalizes the destination to E.164 digits.
    //
    // This used to POST to `https://api.voip.ms/v1.0/sms/send` with Basic auth.
    // No such endpoint exists: VoIP.ms's REST API is a GET against
    // `https://voip.ms/api/v1/rest.php` with `api_username`/`api_password` and
    // `method=sendSMS`. The fabricated URL returned an HTML page, so
    // `response.json()` threw `Unexpected token '<', "<!DOCTYPE "...` and the
    // button reported that as the failure. It could never have sent anything.
    const { SMS } = require('../models/sms');
    const { PluginInstance } = require('../models/plugin_instance');

    // A messaging plugin, when present, supplies its own credentials -- so
    // requiring conf.voipms unconditionally would block a perfectly working
    // setup from testing itself.
    const messagingPlugins = await PluginInstance.list({ where: { category: 'messaging', enabled: true } }).catch(() => []);
    const voipmsConf = conf.voipms || {};
    if (!messagingPlugins.length && (!voipmsConf.username || !voipmsConf.password || !voipmsConf.did)) {
      return res.status(400).json({ error: 'No messaging plugin is loaded and VoIP.ms credentials are not configured. Set username, DID and password in the SMS tab, or load a messaging plugin.' });
    }

    const testMessage = message || `SSO Manager Test SMS: This is a test message from ${conf.name}. If you received this, your SMS configuration is working correctly.`;

    await SMS.send(to, testMessage);
    res.json({ success: true, message: `Test SMS sent to ${to}` });
  } catch(err) {
    // The sender rejects with a useful reason (`VoIP.ms error: <status>`, or a
    // plugin's own error). Surface it as a 400 the UI can display rather than
    // an opaque 500 -- a misconfiguration is the operator's to fix, not a bug.
    return res.status(400).json({ error: err.message || 'Failed to send test SMS' });
  }
});

module.exports = router;