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
    // The stack's service resources are seeded per-site as `<service>-<site>`
    // (bootstrap.js: `sso-manager-718it`, `proxy-718it`, ...). A container's
    // compose service name alone therefore never matches one, which is why the
    // stack's own containers arrived parentless.
    { key: 'serviceSuffix', label: 'Site slug suffix on service resources', type: 'text', required: false, placeholder: '<site slug>' },
    // Containers to leave out entirely. Was a hardcoded
    // /openbao|openboa|bao-renewer/i regex -- correct for this stack and
    // useless for anyone whose secret store is called something else, with no
    // way to change it short of editing the plugin.
    { key: 'ignorePattern', label: 'Ignore containers matching (regex)', type: 'text', required: false, placeholder: 'openbao|bao-renewer' },
    { key: 'location', label: 'Location / Site (optional)', type: 'site_select', required: false, placeholder: 'Default Site' },
    { key: 'autoPromote', label: 'Auto-promote to Directory', type: 'boolean', required: false, default: false }
  ],

  validate: async (config) => {
    if (!config.socketPath && !config.tcpHost) {
      return { ok: false, error: 'Must provide either socketPath or tcpHost' };
    }
    return { ok: true };
  },

  // The default keeps this stack's own secret-store containers out of the
  // catalog; an operator can widen or replace it. An unparseable pattern is
  // reported and then ignored -- a bad regex must not take the whole run down.
  ignoreRegex: (config) => {
    const raw = (config && config.ignorePattern) || 'openbao|openboa|bao-renewer';
    if (!String(raw).trim()) return null;
    try {
      return new RegExp(raw, 'i');
    } catch (err) {
      if (config && config.log) config.log(`ignorePattern is not a valid regex (${err.message}); ignoring nothing`);
      return null;
    }
  },

  discover: async (config) => {
    const isTcp = !!config.tcpHost;
    const ignoreRe = module.exports.ignoreRegex(config);
    
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
            const serviceSuffix = (config.serviceSuffix || '').trim();

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

              const isIgnored = ignoreRe
                ? (ignoreRe.test(name) || ignoreRe.test(composeService || ''))
                : false;

              if (isIgnored) {
                continue;
              }

              resources.push({
                // A container is a service on its host. It used to be
                // `kind: 'container'`, which groupKind() did not recognise, so
                // containers never got access groups through the normal path.
                kind: 'service',
                name: composeService || name,
                slug: slug,
                metadata: {
                  image: c.Image,
                  state: c.State,
                  status: c.Status,
                  ports: ports,
                  subType: 'docker',
                  composeProject: composeProject || undefined,
                  composeService: composeService || undefined,
                  containerName: name,
                  sourceId: stableKey,
                  ignored: isIgnored ? true : undefined,
                  // Part of the deployment we are running inside: already
                  // accounted for, not something to promote.
                  managed: (isOwnStack || isIgnored) ? true : undefined
                }
              });

              // Attach the container to the service it implements.
              //
              // This used to emit the bare compose service name, on the premise
              // that the bootstrap seeded `sso-manager`, `proxy`, `jump-host`
              // under exactly the names compose uses. That stopped being true
              // when service resources became site-scoped: they are seeded as
              // `sso-manager-<site>`, with the bare name kept only as a
              // grandfathering altSlug that nothing outside the bootstrap
              // consults. Every edge from this plugin therefore named a parent
              // that did not exist, was dropped, and left the stack's own
              // containers sitting at the root of the resource tree on every
              // fresh install.
              //
              // So: prefer the site-scoped slug when the suffix is configured,
              // and fall back to the host, which is where an unattachable
              // container belongs anyway.
              const serviceSlug = isOwnStack && composeService
                ? (serviceSuffix ? `${composeService}-${serviceSuffix}` : composeService)
                : '';
              if (serviceSlug) {
                edges.push({ parentSlug: serviceSlug, childSlug: slug, relation: 'runs' });
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
