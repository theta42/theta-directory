const nmap = require('node-nmap');
nmap.nmapLocation = "nmap"; // default

module.exports = {
  // Plugin manifest — see nodejs/services/plugin_registry.js. `targetRange` is
  // not secret (it's a network range to scan), so it lives in the DB row, not
  // OpenBao. nmap itself has no credentials to test, so `validate` only checks
  // the range parses — running a real scan is what `run` does.
  type: 'nmap',
  category: 'discovery',
  name: 'Nmap Network Scan',
  description: 'Discover hosts and services on a network range using nmap OS + port scans.',
  configSchema: [
    { key: 'targetRange', label: 'Target Range', type: 'text', required: true, placeholder: '192.168.1.0/24' }
  ],

  validate: async (config) => {
    const { targetRange } = config;
    if (!targetRange) return { ok: false, error: 'Missing targetRange' };
    // nmap accepts CIDR (a.b.c.d/24), ranges (a.b.c.d-50), and host lists. We
    // only sanity-check shape here — reject anything with shell metacharacters
    // or whitespace, since node-nmap passes this straight to the nmap binary.
    if (/\s|[;|&$`<>]/.test(targetRange)) {
      return { ok: false, error: 'targetRange must not contain whitespace or shell metacharacters' };
    }
    return { ok: true };
  },

  discover: async (config) => {
    const { targetRange } = config;
    if (!targetRange) throw new Error("Missing targetRange for Nmap");

    return new Promise((resolve, reject) => {
      const scan = new nmap.OsAndPortScan(targetRange);
      scan.on('complete', function(data) {
        const resources = [];
        const edges = [];

        for (const host of data) {
          if (!host.mac || !host.ip) continue;
          const hostSlug = `nmap-host-${host.mac.replace(/:/g, '')}`;
          
          const interfaces = [{ mac: host.mac, ip: host.ip }];
          
          resources.push({
            kind: 'host',
            name: host.hostname || host.ip,
            slug: hostSlug,
            metadata: { interfaces, os: host.osNmap }
          });

          if (host.openPorts && host.openPorts.length > 0) {
            for (const port of host.openPorts) {
              const svcSlug = `nmap-svc-${host.mac.replace(/:/g, '')}-${port.port}`;
              resources.push({
                kind: 'service',
                name: `${port.service} on ${port.port}`,
                slug: svcSlug,
                metadata: { port: port.port, protocol: port.protocol }
              });
              edges.push({ parentSlug: hostSlug, childSlug: svcSlug, relation: 'exposes' });
            }
          }
        }
        resolve({ resources, edges });
      });

      scan.on('error', function(error) {
        reject(error);
      });

      scan.startScan();
    });
  },

  // Generalized plugin contract alias for `discover`. See proxmox.js for why
  // this references module.exports rather than `this`.
  run: async (config) => module.exports.discover(config)
};
