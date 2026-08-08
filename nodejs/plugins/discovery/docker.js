const http = require('http');

module.exports = {
  type: 'docker',
  category: 'discovery',
  name: 'Docker Daemon',
  description: 'Discover running containers and networks from a local or remote Docker daemon.',
  configSchema: [
    { key: 'socketPath', label: 'Docker Socket Path', type: 'text', required: false, placeholder: '/var/run/docker.sock' },
    { key: 'tcpHost', label: 'TCP Host (e.g., http://10.0.0.1:2375)', type: 'url', required: false, placeholder: '' },
    // Containers in this compose project are the stack's own. They are already
    // represented in the catalog as services, so they are recorded as managed
    // and linked to the service they implement instead of arriving as
    // unmanaged strangers a fresh install has to triage.
    { key: 'stackProject', label: 'Own compose project', type: 'text', required: false, placeholder: 'theta-suite' },
    { key: 'hostSlug', label: 'Parent host slug', type: 'text', required: false, placeholder: 'host_<hostname>' },
    { key: 'location', label: 'Location / Site (optional)', type: 'site_select', required: false, placeholder: 'Default Site' },
    { key: 'autoPromote', label: 'Auto-promote to Directory', type: 'boolean', required: false, default: true }
  ],

  validate: async (config) => {
    if (!config.socketPath && !config.tcpHost) {
      return { ok: false, error: 'Must provide either socketPath or tcpHost' };
    }
    return { ok: true };
  },

  discover: async (config) => {
    const isTcp = !!config.tcpHost;
    
    const requestOptions = {
      path: '/containers/json',
      method: 'GET'
    };

    if (isTcp) {
      const url = new URL(config.tcpHost);
      requestOptions.host = url.hostname;
      requestOptions.port = url.port || (url.protocol === 'https:' ? 443 : 80);
      requestOptions.protocol = url.protocol;
    } else {
      requestOptions.socketPath = config.socketPath || '/var/run/docker.sock';
    }

    return new Promise((resolve, reject) => {
      const req = http.request(requestOptions, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Docker API error: ${res.statusCode} ${body}`));
          }
          
          try {
            const containers = JSON.parse(body);
            const resources = [];
            const edges = [];

            const stackProject = (config.stackProject || '').trim();
            const hostSlug = (config.hostSlug || '').trim();

            for (const c of containers) {
              const labels = c.Labels || {};
              const composeProject = labels['com.docker.compose.project'] || '';
              const composeService = labels['com.docker.compose.service'] || '';
              const name = c.Names && c.Names.length > 0 ? c.Names[0].replace(/^\//, '') : c.Id.substring(0, 12);

              // A container id changes every time the container is recreated,
              // so an id-derived slug made `docker compose up` mint a brand-new
              // resource on every deploy and orphan the previous one. Prefer
              // identifiers that survive a recreate: the compose project+service
              // it belongs to, else its name.
              const stableKey = composeProject && composeService
                ? `${composeProject}-${composeService}`
                : (name || c.Id.substring(0, 12));
              const slug = `docker-${stableKey.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

              const ports = (c.Ports || []).map(p => p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`).join(', ');
              const isOwnStack = !!(stackProject && composeProject === stackProject);

              resources.push({
                kind: 'container',
                name: composeService || name,
                slug: slug,
                metadata: {
                  image: c.Image,
                  state: c.State,
                  status: c.Status,
                  ports: ports,
                  composeProject: composeProject || undefined,
                  composeService: composeService || undefined,
                  containerName: name,
                  sourceId: stableKey,
                  // Part of the deployment we are running inside: already
                  // accounted for, not something to promote.
                  managed: isOwnStack ? true : undefined
                }
              });

              // Attach the container to the service it implements when the
              // catalog already has one under that slug (the bootstrap seeds
              // `sso-manager`, `proxy`, `jump-host`, … using the same names
              // compose uses). The reconciler drops an edge whose parent does
              // not resolve, so an unmatched name is simply not linked.
              if (isOwnStack && composeService) {
                edges.push({ parentSlug: composeService, childSlug: slug, relation: 'runs' });
              } else if (hostSlug) {
                edges.push({ parentSlug: hostSlug, childSlug: slug, relation: 'hosts' });
              }
            }

            resolve({ resources, edges });
          } catch (e) {
            reject(new Error(`Failed to parse Docker response: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => reject(new Error(`Docker connection error: ${e.message}`)));
      req.end();
    });
  }
};
