const http = require('http');

module.exports = {
  type: 'docker',
  category: 'discovery',
  name: 'Docker Daemon',
  description: 'Discover running containers and networks from a local or remote Docker daemon.',
  configSchema: [
    { key: 'socketPath', label: 'Docker Socket Path', type: 'text', required: false, placeholder: '/var/run/docker.sock' },
    { key: 'tcpHost', label: 'TCP Host (e.g., http://10.0.0.1:2375)', type: 'url', required: false, placeholder: '' }
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

            for (const c of containers) {
              const name = c.Names && c.Names.length > 0 ? c.Names[0].replace(/^\\//, '') : c.Id.substring(0, 12);
              const slug = `docker-cnt-${c.Id.substring(0, 12)}`;
              
              const ports = (c.Ports || []).map(p => p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`).join(', ');
              
              resources.push({
                kind: 'container',
                name: name,
                slug: slug,
                metadata: {
                  image: c.Image,
                  state: c.State,
                  status: c.Status,
                  ports: ports
                }
              });
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
