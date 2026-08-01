---
layout: default
title: Discovery Plugins
nav_order: 5
---

# Discovery Plugins

The SSO Manager supports a robust plugin architecture for auto-discovering devices, hosts, and services across your home lab or data center. Plugins run on a scheduled cron and feed their data into a central **Reconciliation Engine** that smartly merges information based on MAC addresses and IPs.

## Writing a Custom Plugin

Plugins are simple JavaScript files placed in `nodejs/plugins/discovery/`.

A plugin must export a single `discover` async function that returns a standardized graph of `resources` and `edges`.

### Plugin Skeleton

```javascript
// nodejs/plugins/discovery/my_custom_plugin.js
module.exports = {
  discover: async (config) => {
    const { url, apiKey } = config; // Provided by your configuration
    
    const resources = [];
    const edges = [];

    // 1. Fetch your data from an API
    // const data = await fetch(...);

    // 2. Map data to Resources
    resources.push({
      kind: 'network_device', // 'host', 'service', 'network_device', 'unmanaged_device'
      name: 'My Switch',
      slug: 'my-switch-01',
      metadata: {
        make: 'Vendor',
        model: 'Model X',
        interfaces: [
          { mac: '00:1A:2B:3C:4D:5E', ip: '10.0.0.5' }
        ]
      }
    });

    // 3. Map relations to Edges (optional)
    edges.push({
      parentSlug: 'my-switch-01',
      childSlug: 'some-connected-client-slug',
      relation: 'connected_to' // 'hosts', 'exposes', 'connected_to'
    });

    return { resources, edges };
  }
};
```

## Configuration

Plugins are automatically loaded and executed by the internal BullMQ job scheduler. You configure them in your `config/sso-secrets.js`:

```javascript
module.exports = {
  // ... existing config ...
  discovery: {
    plugins: {
      my_custom_plugin: {
        enabled: true,
        cron: '*/30 * * * *', // Run every 30 minutes
        url: 'https://api.example.com',
        apiKey: 'secret-key'
      },
      nmap: {
        enabled: true,
        cron: '0 * * * *',
        targetRange: '192.168.1.0/24'
      }
    }
  }
};
```

## The Reconciliation Engine

When your plugin returns its graph, the Reconciliation Engine takes over:
1. **Matching:** It tries to find an existing device in the database matching any MAC address provided in the `interfaces` array. If no MAC matches, it falls back to IP address, and then to `slug`.
2. **Merging:** If it finds a match, it gracefully merges the metadata (so your plugin can add CPU info to a host that NMAP previously found).
3. **Source Tracking:** It records your plugin's filename in the `discovery_sources` array on the resource, and updates the `last_seen` timestamp.
4. **LDAP Spam Prevention:** Brand new devices are marked as `managed: false`. They will not pollute your LDAP directory until an admin explicitly promotes them.
