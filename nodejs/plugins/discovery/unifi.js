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
    { key: 'password', label: 'Password',       type: 'password', required: true, secret: true },
    // The UniFi controller's own site name, which is NOT the directory's site.
    // This was hardcoded to `default`, so a controller managing several UniFi
    // sites only ever reported the first one.
    { key: 'unifiSite', label: 'UniFi site name', type: 'text', required: false, placeholder: 'default' },
    // Clients are every phone, TV, laptop and doorbell on the LAN. Importing
    // them turns a directory of managed infrastructure into a DHCP lease table,
    // so it is off unless asked for.
    { key: 'importClients', label: 'Import connected clients as hosts', type: 'boolean', required: false, default: false },
    { key: 'location', label: 'Location / Site (optional)', type: 'site_select', required: false, placeholder: 'Default Site' },
    { key: 'autoPromote', label: 'Auto-promote to Directory', type: 'boolean', required: false, default: false }
  ],

  // What a UniFi device model is, in the directory's vocabulary.
  //
  // UniFi reports a `type` ('uap', 'usw', 'ugw', 'udm') and a model string.
  // Emitting NO subtype -- which this plugin used to do -- is not neutral: an
  // empty subType falls in the ssh-capable bucket, so every switch and access
  // point a controller knew about was quietly offered as a jump target.
  classifyDevice: (dev) => {
    const type = String((dev && dev.type) || '').toLowerCase();
    const model = String((dev && dev.model) || '').toLowerCase();
    if (type === 'uap' || /^(u6|uap|uwb|u7)/.test(model)) return 'unifi_ap';
    if (type === 'usw' || /^(us|usw|usl)/.test(model)) return 'unifi_switch';
    if (type === 'ugw' || type === 'udm' || /^(ugw|udm|uxg)/.test(model)) return 'router';
    return 'unknown';
  },

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
    const unifiSite = (config.unifiSite || 'default').trim() || 'default';

    // 2. Devices (switches / APs / gateways)
    const devRes = await fetch(`${url}${basePath}/api/s/${encodeURIComponent(unifiSite)}/stat/device`, { headers, agent });
    if (!devRes.ok) throw new Error(`UniFi device query failed (${devRes.status}) for site "${unifiSite}"`);
    const devData = (await devRes.json()).data || [];

    for (const dev of devData) {
      if (!dev.mac) continue;
      const devSlug = `unifi-device-${dev.mac.replace(/:/g, '')}`;
      resources.push({
        kind: 'host',
        name: dev.name || dev.model || dev.mac,
        slug: devSlug,
        metadata: {
          subType: module.exports.classifyDevice(dev),
          subTypeSource: 'unifi-inference',
          make: 'Ubiquiti',
          model: dev.model,
          firmware: dev.version,
          // The MAC is UniFi's own stable key for a device, and the reconciler
          // treats a MAC as a strong identity. Without a sourceId every re-run
          // had to fall back to weak matching.
          sourceId: dev.mac,
          macAddress: dev.mac,
          ip: dev.ip || undefined,
          interfaces: [{ mac: dev.mac, ip: dev.ip || null }]
        }
      });
    }

    // Uplink topology, between devices we actually reported.
    const known = new Set(resources.map(r => r.slug));
    for (const dev of devData) {
      const uplinkMac = dev.uplink && dev.uplink.uplink_mac;
      if (!dev.mac || !uplinkMac) continue;
      const childSlug = `unifi-device-${dev.mac.replace(/:/g, '')}`;
      const parentSlug = `unifi-device-${uplinkMac.replace(/:/g, '')}`;
      if (known.has(parentSlug) && known.has(childSlug)) {
        edges.push({ parentSlug, childSlug, relation: 'hosts' });
      }
    }

    // 3. Clients, only when asked for. Every phone and TV on the LAN is a
    // client; importing them by default turned the directory into a DHCP lease
    // table, and each one arrived with no subtype -- which made it ssh-capable.
    if (config.importClients) {
      const clientRes = await fetch(`${url}${basePath}/api/s/${encodeURIComponent(unifiSite)}/stat/sta`, { headers, agent });
      if (!clientRes.ok) throw new Error(`UniFi client query failed (${clientRes.status}) for site "${unifiSite}"`);
      const clientData = (await clientRes.json()).data || [];

      for (const client of clientData) {
        if (!client.mac) continue;
        const clientSlug = `unifi-client-${client.mac.replace(/:/g, '')}`;
        resources.push({
          kind: 'host',
          name: client.hostname || client.name || client.mac,
          slug: clientSlug,
          metadata: {
            // A DHCP client is not something we can classify, and guessing
            // would make it a jump target. `unknown` is not ssh-capable.
            subType: 'unknown',
            subTypeSource: 'unifi-client',
            sourceId: client.mac,
            macAddress: client.mac,
            ip: client.ip || undefined,
            interfaces: [{ mac: client.mac, ip: client.ip || null }]
          }
        });

        // Which switch/AP it is on. `hosts`, not a bespoke relation: the graph
        // has one containment relation and the reconciler prunes on it.
        const apSlug = client.ap_mac ? `unifi-device-${client.ap_mac.replace(/:/g, '')}` : null;
        if (apSlug && known.has(apSlug)) {
          edges.push({ parentSlug: apSlug, childSlug: clientSlug, relation: 'hosts' });
        }
      }
    }

    return { resources, edges };
  },

  // Generalized plugin contract alias for `discover`. See proxmox.js for why
  // this references module.exports rather than `this`.
  run: async (config) => module.exports.discover(config)
};
