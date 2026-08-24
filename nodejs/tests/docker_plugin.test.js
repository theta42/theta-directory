'use strict';

// Docker discovery: which resource a container is attached to.
//
// The regression these cover: the plugin emitted the bare compose service name
// ('sso-manager') as the parent slug, but service resources are seeded
// site-scoped ('sso-manager-718it'). Nothing resolved, every edge was dropped,
// and the stack's own containers appeared at the root of the resource tree on
// every fresh install.

const http = require('http');
const dockerPlugin = require('../plugins/discovery/docker');

// A throwaway Docker-API-shaped server, so the plugin's real HTTP path runs.
function withDockerApi(containers, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(containers));
    });
    srv.listen(0, '127.0.0.1', async () => {
      const { port } = srv.address();
      try {
        resolve(await fn({ tcpHost: `http://127.0.0.1:${port}` }));
      } catch (e) {
        reject(e);
      } finally {
        srv.close();
      }
    });
  });
}

const stackContainer = {
  Id: 'abc123def456',
  Names: ['/sso-manager'],
  Image: 'theta-suite-sso-manager',
  State: 'running',
  Status: 'Up 2 hours (healthy)',
  Ports: [],
  Labels: {
    'com.docker.compose.project': 'theta-suite',
    'com.docker.compose.service': 'sso-manager',
  },
};

describe('docker discovery parenting', () => {
  test('attaches a stack container to the site-scoped service resource', async () => {
    const { resources, edges } = await withDockerApi([stackContainer], (base) =>
      dockerPlugin.discover({ ...base, stackProject: 'theta-suite', serviceSuffix: '718it', hostSlug: 'host_stack' })
    );

    expect(resources).toHaveLength(1);
    expect(resources[0].slug).toBe('docker-theta-suite-sso-manager');
    expect(edges).toEqual([
      { parentSlug: 'sso-manager-718it', childSlug: 'docker-theta-suite-sso-manager', relation: 'runs' },
    ]);
  });

  test('falls back to the bare service name when no suffix is configured', async () => {
    // Pre-site-scoping installs, and anyone who set stackProject by hand.
    const { edges } = await withDockerApi([stackContainer], (base) =>
      dockerPlugin.discover({ ...base, stackProject: 'theta-suite' })
    );
    expect(edges[0].parentSlug).toBe('sso-manager');
  });

  test('a container outside the stack is parented to the host, not a service', async () => {
    const other = {
      ...stackContainer,
      Id: 'ffff0000',
      Names: ['/somebody-elses'],
      Labels: { 'com.docker.compose.project': 'other', 'com.docker.compose.service': 'web' },
    };
    const { edges } = await withDockerApi([other], (base) =>
      dockerPlugin.discover({ ...base, stackProject: 'theta-suite', serviceSuffix: '718it', hostSlug: 'host_stack' })
    );
    expect(edges).toEqual([
      { parentSlug: 'host_stack', childSlug: 'docker-other-web', relation: 'hosts' },
    ]);
  });

  test('slug survives a container recreate (id is not part of it)', async () => {
    const recreated = { ...stackContainer, Id: 'totally-different-id' };
    const a = await withDockerApi([stackContainer], (b) => dockerPlugin.discover({ ...b, stackProject: 'theta-suite' }));
    const c = await withDockerApi([recreated], (b) => dockerPlugin.discover({ ...b, stackProject: 'theta-suite' }));
    expect(a.resources[0].slug).toBe(c.resources[0].slug);
  });
});
