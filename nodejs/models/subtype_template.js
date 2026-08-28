const { Model } = require('@simpleworkjs/orm');
const crypto = require('crypto');

class SubtypeTemplate extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    slug: { type: 'string', isRequired: true, unique: true },
    name: { type: 'string', isRequired: true },
    target_kind: { type: 'string', isRequired: true }, // 'site', 'host', or 'service'
    schema: { type: 'json', default: {} }, // JSON Schema for dynamic form rendering and validation
    status_rules: { type: 'json', default: [] }, // Rules for evaluating telemetry into a status
    icon: { type: 'string' }, // e.g. mdi-server
    created_on: { type: 'integer' },
    updated_on: { type: 'integer' }
  };

  // Optional: Provide default pre-installed templates if missing
  static async seedDefaults() {
    const defaults = [
      { slug: 'linux', name: 'Linux Server', target_kind: 'host', icon: 'mdi-linux' },
      { slug: 'windows', name: 'Windows Server', target_kind: 'host', icon: 'mdi-windows' },
      { slug: 'proxmox', name: 'Proxmox Hypervisor', target_kind: 'host', icon: 'mdi-server-network' },
      { slug: 'theta-agent', name: 'Theta Agent', target_kind: 'service', icon: 'mdi-shield-check' },
      { 
        slug: 'port-forward', 
        name: 'Port Forward', 
        target_kind: 'service', 
        icon: 'mdi-router-wireless',
        schema: {
          properties: {
            targetPort: { type: 'number', description: 'Internal Port' },
            sourcePort: { type: 'number', description: 'External Port' },
            protocol: { type: 'string', description: 'tcp/udp' },
            isExternalReachable: { type: 'boolean', description: 'Reachable externally' }
          }
        }
      }
    ];

    for (const def of defaults) {
      const existing = await this.list({ where: { slug: def.slug } });
      if (!existing || existing.length === 0) {
        await this.create({
          id: crypto.randomUUID(),
          ...def,
          created_on: Math.floor(Date.now() / 1000)
        });
      }
    }
  }
}

module.exports = { SubtypeTemplate };
