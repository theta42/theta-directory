const { Webhook } = require('../models/webhook');
const crypto = require('crypto');
const fetch = require('node-fetch');

class WebhookEmitter {
  static async emit(event, payload) {
    try {
      const hooks = await Webhook.list({ where: { isActive: true } });
      const matched = hooks.filter(h => !h.events || h.events.length === 0 || h.events.includes(event));
      
      for (const hook of matched) {
        this.sendPayload(hook, event, payload).catch(err => console.error(`Webhook ${hook.name} failed:`, err.message));
      }
    } catch (e) {
      console.error('Error emitting webhook:', e);
    }
  }

  static async sendPayload(hook, event, payload) {
    const body = JSON.stringify({ event, payload, timestamp: Date.now() });
    const headers = { 'Content-Type': 'application/json' };
    
    if (hook.secret) {
      const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
      headers['X-Theta-Signature'] = signature;
    }

    const res = await fetch(hook.url, { method: 'POST', body, headers, timeout: 5000 });
    if (!res.ok) {
      throw new Error(`Status ${res.status}`);
    }
  }
}

module.exports = { WebhookEmitter };
