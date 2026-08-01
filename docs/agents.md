---
layout: default
title: Discovery Agents
nav_order: 5
---

# Discovery Agents

The SSO Manager supports a robust agent architecture for auto-discovering devices, hosts, and services across your home lab or data center. Agents run on a scheduled cron and feed their data into a central **Reconciliation Engine** that smartly merges information based on MAC addresses and IPs.

## Writing a Custom Agent

Agents are simple JavaScript files placed in `nodejs/agents/discovery/`.

A agent must export a single `discover` async function that returns a standardized graph of `resources` and `edges`.

### Agent Skeleton

```javascript
// nodejs/agents/discovery/my_custom_agent.js
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

Agents are automatically loaded and executed by the internal BullMQ job scheduler. You configure them in your `config/sso-secrets.js`:

```javascript
module.exports = {
  // ... existing config ...
  discovery: {
    agents: {
      my_custom_agent: {
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

When your agent returns its graph, the Reconciliation Engine takes over:
1. **Matching:** It tries to find an existing device in the database matching any MAC address provided in the `interfaces` array. If no MAC matches, it falls back to IP address, and then to `slug`.
2. **Merging:** If it finds a match, it gracefully merges the metadata (so your agent can add CPU info to a host that NMAP previously found).
3. **Source Tracking:** It records your agent's filename in the `discovery_sources` array on the resource, and updates the `last_seen` timestamp.
4. **LDAP Spam Prevention:** Brand new devices are marked as `managed: false`. They will not pollute your LDAP directory until an admin explicitly promotes them.
