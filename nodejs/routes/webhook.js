const router = require('express').Router();
const { Webhook } = require('../models/webhook');
const crypto = require('crypto');
const middleware = require('../middleware/auth');
const permission = require('../utils/permission');

// Webhook management is admin-only. The whole router is gated: a missing or
// non-admin session never reaches the handlers.
router.use(middleware.auth);
router.use(async (req, res, next) => {
  try {
    await permission.byGroup(req.user, ['app_sso_admin', 'app_super_admin']);
    next();
  } catch (err) {
    return res.status(403).json({ status: 'error', message: 'admin only' });
  }
});

// Validate that a webhook URL uses http or https only. A javascript: or
// file:// URL would be a server-side request forgery / local file read vector
// when the emitter fetches it.
function urlSchemeAllowed(raw) {
  try {
    const u = new URL(String(raw || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

// GET /api/webhooks
router.get('/', async (req, res, next) => {
  try {
    const hooks = await Webhook.list();
    res.json({ results: hooks });
  } catch (err) { next(err); }
});

// POST /api/webhooks
router.post('/', async (req, res, next) => {
  try {
    const { name, url, events, secret } = req.body;
    if (!urlSchemeAllowed(url)) {
      return res.status(400).json({ status: 'error', message: 'webhook URL must use http or https' });
    }
    const hook = await Webhook.create({
      id: crypto.randomUUID(),
      name, url, events, secret,
      created_on: Math.floor(Date.now() / 1000)
    });
    res.json({ results: hook });
  } catch (err) { next(err); }
});

// PUT /api/webhooks/:id — update (reuse the same scheme gate)
router.put('/:id', async (req, res, next) => {
  try {
    const hook = await Webhook.get(req.params.id);
    if (!hook) return res.status(404).json({ error: 'Not found' });
    const { name, url, events, secret } = req.body;
    if (url !== undefined && !urlSchemeAllowed(url)) {
      return res.status(400).json({ status: 'error', message: 'webhook URL must use http or https' });
    }
    const patch = {};
    if (name !== undefined) patch.name = name;
    if (url !== undefined) patch.url = url;
    if (events !== undefined) patch.events = events;
    if (secret !== undefined) patch.secret = secret;
    const updated = await hook.update(patch);
    res.json({ results: updated });
  } catch (err) { next(err); }
});

// DELETE /api/webhooks/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const hook = await Webhook.get(req.params.id);
    if (!hook) return res.status(404).json({ error: 'Not found' });
    await hook.delete();
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
