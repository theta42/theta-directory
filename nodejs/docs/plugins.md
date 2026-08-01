# Plugins & Scheduler

The SSO Manager includes a flexible background task runner and discovery system. Plugins are defined statically in your deployment configuration (`sso-secrets.js`) and run based on their defined `cron` schedule. 

## Writing Custom Plugins

You can write custom plugins to discover resources, manage internal state, or run automated scripts. Plugins must be placed in the `plugins/discovery/` directory of the SSO Manager node codebase.

A plugin file must export a `discover` method.

**Example Plugin (`plugins/discovery/my_plugin.js`):**

```javascript
module.exports = {
  discover: async function(config) {
    // The config object contains any keys passed in sso-secrets.js for this plugin.
    
    // Perform discovery logic, hit external APIs, etc.
    const resources = [
      {
        slug: 'my-custom-resource-1',
        name: 'My Resource 1',
        kind: 'Host',
        metadata: {
          ip: '10.0.0.100',
          source: 'My Custom Plugin'
        }
      }
    ];
    
    // Return the discovered resources array. The discovery reconciler will 
    // automatically save these to the Network Discovery database.
    return resources;
  }
};
```

## Configuring Plugins

In your `sso-secrets.js` file, add your plugin to the `discovery.plugins` object:

```javascript
module.exports = {
  // ...
  discovery: {
    plugins: {
      my_plugin: {
        enabled: true,
        cron: "0 * * * *", // Run every hour
        my_custom_key: "my_custom_value" // Passed to the config argument in discover()
      }
    }
  }
  // ...
};
```

### Overriding Timing and Enable/Disable

From the **Plugins & Scheduler** tab in the Directory Dashboard, you can override the schedule and enable/disable state for each plugin. These overrides take precedence over `sso-secrets.js` and are stored internally.

## Scheduler Internals

The scheduler uses BullMQ backed by Redis to manage execution. It automatically performs garbage collection on stale network resources (resources not updated in > 7 days) and triggers your plugins at the defined intervals.
