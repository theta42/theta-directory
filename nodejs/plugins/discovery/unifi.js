const fetch = require('node-fetch');
const https = require('https');

const agent = new https.Agent({
  rejectUnauthorized: false
});

module.exports = {
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
  }
};
