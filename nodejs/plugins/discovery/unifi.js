const fetch = require('node-fetch');
const https = require('https');

const agent = new https.Agent({
  rejectUnauthorized: false
});

module.exports = {
  // Plugin manifest — see nodejs/services/plugin_registry.js. `password` is
  // secret and stored in OpenBao (secret/plugins/<instance-id>/conf).
  type: 'unifi',
  category: 'discovery',
  name: 'UniFi Network',
  description: 'Discover UniFi network devices and clients from a UniFi Controller / UDM endpoint.',
  configSchema: [
    { key: 'url',      label: 'Controller URL', type: 'url',      required: true, placeholder: 'https://unifi.example:8443' },
    { key: 'user',     label: 'Username',       type: 'text',     required: true },
    { key: 'password', label: 'Password',       type: 'password', required: true, secret: true }
  ],

  // "Test": attempt the UDM login (falls back to the legacy controller login);
  // succeeds only if one of the two login endpoints returns 200.
  validate: async (config) => {
    const { url, user, password } = config;
    if (!url || !user || !password) return { ok: false, error: 'Missing url, user, or password' };
    try {
      let loginRes = await fetch(`${url}/api/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password }), agent
      });
      if (!loginRes.ok) {
        loginRes = await fetch(`${url}/api/login`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: user, password }), agent
        });
      }
      if (!loginRes.ok) return { ok: false, error: `UniFi auth failed (${loginRes.status})` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  discover: async (config) => {
    const { url, user, password } = config;
    if (!url || !user || !password) {
      throw new Error("Missing Unifi config");
    }

    // 1. Authenticate
    let loginRes = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password }),
      agent
    });

    let isUdm = true;
    if (!loginRes.ok) {
      loginRes = await fetch(`${url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password }),
        agent
      });
      isUdm = false;
    }

    if (!loginRes.ok) {
      throw new Error(`Unifi auth failed: ${loginRes.status}`);
    }

    const cookie = loginRes.headers.get('set-cookie');
    // UniFi often requires the CSRF token from the cookie
    let csrf = '';
    if (cookie) {
      const match = cookie.match(/csrf_token=([^;]+)/);
      if (match) csrf = match[1];
    }
    const headers = { 'Cookie': cookie, 'X-Csrf-Token': csrf };

    const resources = [];
    const edges = [];

    const basePath = isUdm ? '/proxy/network' : '';

    // 2. Get Devices (Switches/APs)
    const devRes = await fetch(`${url}${basePath}/api/s/default/stat/device`, { headers, agent });
    const devData = (await devRes.json()).data || [];

    for (const dev of devData) {
      const devSlug = `unifi-device-${dev.mac.replace(/:/g, '')}`;
      resources.push({
        kind: 'network_device',
        name: dev.name || dev.model,
        slug: devSlug,
        metadata: {
          make: 'Ubiquiti',
          model: dev.model,
          firmware: dev.version,
          interfaces: [{ mac: dev.mac, ip: dev.ip }]
        }
      });
    }

    // 3. Get Clients
    const clientRes = await fetch(`${url}${basePath}/api/s/default/stat/sta`, { headers, agent });
    const clientData = (await clientRes.json()).data || [];

    for (const client of clientData) {
      const clientSlug = `unifi-client-${client.mac.replace(/:/g, '')}`;
      resources.push({
        kind: 'host', // Or unmanaged_device initially
        name: client.hostname || client.name || client.mac,
        slug: clientSlug,
        metadata: {
          interfaces: [{ mac: client.mac, ip: client.ip }]
        }
      });
      
      // If we know which switch/AP it's on
      if (client.ap_mac) {
        const apSlug = `unifi-device-${client.ap_mac.replace(/:/g, '')}`;
        edges.push({ parentSlug: apSlug, childSlug: clientSlug, relation: 'connected_to' });
      }
    }

    return { resources, edges };
  },

  // Generalized plugin contract alias for `discover`. See proxmox.js for why
  // this references module.exports rather than `this`.
  run: async (config) => module.exports.discover(config)
};
