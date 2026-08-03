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
      // OsAndPortScan requires root (for -O). NmapScan does a basic port scan (TCP connect if non-root).
      // Pass custom arguments in constructor so node-nmap includes them before spawning nmap process.
      // -Pn: treat all hosts as online (skip ping/ARP host discovery which fails inside Docker containers NAT/bridge)
      // -sT: TCP connect scan (unprivileged scan compatible with container environments)
      // -F: fast scan (100 top ports)
      // --min-rate 100: speed up scan rate
      const customFlags = ['-Pn', '-sT', '-F', '--min-rate', '100'];
      const scan = new nmap.NmapScan(targetRange, customFlags);
      
      if (config.log) config.log(`Starting nmap scan: ${scan.command.join(' ')}`);

      scan.on('complete', function(data) {
        if (config.log) config.log(`Scan complete. Found ${data ? data.length : 0} hosts.`);
        const resources = [];
        const edges = [];

        for (const host of data) {
          if (!host.ip) continue;
          const hostId = host.mac ? host.mac.replace(/:/g, '') : host.ip.replace(/\\./g, '_');
          const hostSlug = `nmap-host-${hostId}`;
          
          const interfaces = [{ mac: host.mac || null, ip: host.ip }];
          
          resources.push({
            kind: 'host',
            name: host.hostname || host.ip,
            slug: hostSlug,
            metadata: { interfaces, os: host.osNmap }
          });

          if (host.openPorts && host.openPorts.length > 0) {
            for (const port of host.openPorts) {
              const svcSlug = `nmap-svc-${hostId}-${port.port}`;
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
        // node-nmap's spawn-missing-binary message ("NMAP not found at command
        // location: nmap") is opaque to an admin reading lastError. Translate
        // it into something actionable. (The Dockerfile installs nmap in the
        // app image; this only fires if someone runs outside the container or
        // strips the package.)
        var msg = (error && error.message) || String(error);
        if (/nmap.*not found|command location/i.test(msg)) {
          reject(new Error('nmap binary not installed in the container image (rebuild with Dockerfile.openldap, which apk-adds nmap)'));
        } else {
          reject(error);
        }
      });

      scan.startScan();
    });
  },

  // Generalized plugin contract alias for `discover`. See proxmox.js for why
  // this references module.exports rather than `this`.
  run: async (config) => module.exports.discover(config)
};
