const { Model } = require('@simpleworkjs/orm');

class Webhook extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    name: { type: 'string', isRequired: true },
    url: { type: 'string', isRequired: true },
    events: { type: 'json', default: [] }, // e.g. ['discovery.new_device', 'resource.updated']
    secret: { type: 'string' },
    isActive: { type: 'boolean', default: true },
    created_on: { type: 'integer' },
  };
}

module.exports = { Webhook };
