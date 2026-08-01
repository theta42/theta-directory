const nmap = require('node-nmap');
nmap.nmapLocation = "nmap"; // default

module.exports = {
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
  }
};
