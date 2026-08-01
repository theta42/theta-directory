require('./setup');
const { Webhook } = require('../models/webhook');
const { WebhookEmitter } = require('../services/webhook_emitter');
const crypto = require('crypto');

describe('WebhookEmitter', () => {
  let webhook;

  beforeEach(async () => {
    // Clear webhooks before each test
    const all = await Webhook.list();
    for (const w of all) {
      await w.delete();
    }
    
    webhook = await Webhook.create({
      id: crypto.randomUUID(),
      name: 'Test Webhook',
      url: 'http://localhost:9999/dummy',
      events: ['discovery.new_device'],
      secret: 'mysecret',
      created_on: Math.floor(Date.now() / 1000)
    });
  });

  it('should not throw when emitting an event', async () => {
    // We expect this to fail network connection but be caught gracefully by the emitter
    await WebhookEmitter.emit('discovery.new_device', { name: 'Device1' });
    // If it doesn't throw, test passes
    expect(true).toBe(true);
  });
});
