const router = require('express').Router();
const { Webhook } = require('../models/webhook');
const crypto = require('crypto');

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
    const hook = await Webhook.create({
      id: crypto.randomUUID(),
      name, url, events, secret,
      created_on: Math.floor(Date.now() / 1000)
    });
    res.json({ results: hook });
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
