const nmap = require('node-nmap');
nmap.nmapLocation = "nmap"; // default

// Ports whose service is unambiguous enough to name. Anything else stays
// `unknown-service`: a guess dressed as a fact is worse than an admission.
const NMAP_SERVICE_SUBTYPES = {
  22: 'ssh', 80: 'http', 443: 'http', 8080: 'http', 8443: 'http',
  5432: 'postgresql', 6379: 'redis', 8200: 'openbao_vault', 51820: 'wireguard'
};

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
    { key: 'targetRange', label: 'Target Range', type: 'text', required: true, placeholder: '192.168.1.0/24' },
    { key: 'location', label: 'Location / Site (optional)', type: 'site_select', required: false, placeholder: 'Default Site' },
    { key: 'autoPromote', label: 'Auto-promote to Directory', type: 'boolean', required: false, default: false }
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

  // What a scan can honestly conclude about a host from its OS banner and its
  // open ports. This is guesswork, and it is labelled as such: `unknown` is a
  // real answer and the DEFAULT one.
  //
  // Emitting no subType at all -- which this plugin used to do -- is not
  // neutral. An empty subType falls in the ssh-capable bucket
  // (SSH_CAPABLE_HOST_SUBTYPES in services/subtype_templates.js), so every
  // printer, camera and switch a scan turned up was quietly offered as a jump
  // target. `unknown` is not ssh-capable, so classification failure now fails
  // closed.
  classifyHost: (host) => {
    const os = String((host && host.osNmap) || '').toLowerCase();
    const ports = new Set(((host && host.openPorts) || []).map(p => Number(p.port)));
    const services = ((host && host.openPorts) || [])
      .map(p => String(p.service || '').toLowerCase()).join(' ');

    // OS banner first: it is the strongest signal nmap gives.
    if (/windows/.test(os)) return 'windows';
    if (/(printer|jetdirect)/.test(os) || ports.has(9100) || /jetdirect|printer|ipp/.test(services)) return 'printer';
    if (/(camera|hikvision|dahua|axis)/.test(os)) return 'camera';
    if (/(pfsense|opnsense)/.test(os)) return 'pfsense';
    if (/(router|mikrotik|edgeos|routeros|openwrt)/.test(os)) return 'router';
    if (/(switch|procurve|catalyst)/.test(os)) return 'switch';
    if (/(access point|unifi|ubiquiti)/.test(os)) return 'ap';
    if (/(ilo|idrac|bmc|integrated lights-out)/.test(os)) return 'bmc';
    if (/(linux|ubuntu|debian|centos|red hat|alpine)/.test(os)) return 'linux';

    // Port shape, only where it is genuinely characteristic.
    if (ports.has(8006)) return 'proxmox';       // Proxmox VE web UI
    if (ports.has(3389) && !ports.has(22)) return 'windows';
    if (ports.has(9100)) return 'printer';
    if ((ports.has(554) || ports.has(8554)) && !ports.has(22)) return 'camera';

    // An SSH port alone is not enough to call something a Linux server -- a
    // switch, a NAS and a firewall all answer on 22.
    return 'unknown';
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
            metadata: {
              interfaces,
              os: host.osNmap,
              subType: module.exports.classifyHost(host),
              // How the subtype was arrived at. A scan guess and an operator's
              // decision must not look the same in the directory.
              subTypeSource: 'nmap-inference'
            }
          });

          if (host.openPorts && host.openPorts.length > 0) {
            for (const port of host.openPorts) {
              const svcSlug = `nmap-svc-${hostId}-${port.port}`;
              resources.push({
                kind: 'service',
                name: `${port.service} on ${port.port}`,
                slug: svcSlug,
                metadata: {
                  port: port.port,
                  protocol: port.protocol,
                  subType: NMAP_SERVICE_SUBTYPES[Number(port.port)] || 'unknown-service',
                  subTypeSource: 'nmap-inference'
                }
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
          return;
        }
        // node-nmap (node_modules/node-nmap/index.js) treats ANY stderr
        // output from the nmap binary as a fatal scan error -- including
        // nmap's own benign RTT timing-calibration warnings ("RTTVAR has
        // grown to over N seconds, decreasing to M"), which it prints
        // *during* a scan that goes on to complete normally. That means a
        // scan that actually succeeded (valid XML already sitting in
        // scan.rawData) got thrown away and reported as a failed run with
        // zero hosts discovered -- not just a noisy log line. Recover by
        // manually re-running node-nmap's own XML-parse-then-complete path
        // (rawDataHandler -> scanComplete -> the 'complete' listener above)
        // when the "error" is this specific known-benign nmap message and
        // there's actually output to parse. A genuine XML parse failure
        // re-emits 'error' with a different message, which falls through to
        // reject() below same as before -- this only widens the recovery
        // path, it doesn't swallow real failures.
        if (/RTTVAR has grown/i.test(msg) && scan.rawData) {
          scan.rawDataHandler(scan.rawData);
          return;
        }
        reject(error);
      });

      scan.startScan();
    });
  },

  // Generalized plugin contract alias for `discover`. See proxmox.js for why
  // this references module.exports rather than `this`.
  run: async (config) => module.exports.discover(config)
};
