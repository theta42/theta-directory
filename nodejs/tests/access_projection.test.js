'use strict';

// Access projection — who can reach what, and why.
//
// Pure unit tests: the projection takes the resource list and the edge list as
// arguments precisely so this can be exercised without a directory behind it.
//
// Agent binding is graph-based: a `theta-agent` service resource is a child of
// the host, and the Agent row points at that service via `resourceId`. There is
// no metadata.agentId on hosts.

const { accessibleResources } = require('../services/access_projection');
const { templateFor, isJumpTarget } = require('../services/subtype_templates');

const SITE = { id: 'site1', kind: 'site', slug: 'site_718it', metadata: {} };

function host(id, slug, metadata = {}) {
  return { id, kind: 'host', slug, name: slug, metadata: { subType: 'linux', ...metadata } };
}
function svc(id, slug, metadata = {}) {
  return { id, kind: 'service', slug, name: slug, metadata: { subType: 'systemd', ...metadata } };
}
function agentSvc(id, slug, agentId) {
  return { id, kind: 'service', slug, name: 'Theta Agent', metadata: { subType: 'theta-agent', agentId } };
}
function agent(id, resourceId, revoked = false) {
  return { id, resourceId, revoked };
}
const edge = (parentId, childId) => ({ parentId, childId, relation: 'hosts' });

const DEFAULT_AGENTS = [
  agent('a1', 'a1-svc'),
  agent('a2', 'a2-svc'),
  agent('a9', 'a9-svc'),
  agent('x', 'x-svc')
];

function project(resources, edges, groups, grantedIds = [], agents = DEFAULT_AGENTS) {
  return accessibleResources(resources, edges, {
    groupIds: new Set(grantedIds), memberOf: groups, agents
  }).map(r => r.slug).sort();
}

describe('agent-enrolled hosts are jump targets without a per-host grant', () => {
  const agentHost = host('h1', 'lxc-213', { managed: true, discovery_sources: ['theta-agent'] });
  const agentService = agentSvc('a1-svc', 'svc-lxc-213-theta-agent', 'a1');
  const plainHost = host('h2', 'lxc-999', { managed: true, discovery_sources: ['proxmox-718'] });
  const resources = [SITE, agentHost, agentService, plainHost];
  const edges = [edge('site1', 'h1'), edge('h1', 'a1-svc'), edge('site1', 'h2')];

  test('a global admin reaches every agent host, with no ResourceGroup rows at all', () => {
    expect(project(resources, edges, ['god_admin'])).toContain('lxc-213');
  });

  test('the site aggregate grants it too', () => {
    expect(project(resources, edges, ['site_718it_hosts_access'])).toContain('lxc-213');
  });

  test('a host WITHOUT an agent still needs an explicit grant', () => {
    expect(project(resources, edges, ['god_admin'])).not.toContain('lxc-999');
    expect(project(resources, edges, ['god_admin'], ['h2'])).toContain('lxc-999');
  });

  test('a user with no relevant groups reaches nothing', () => {
    expect(project(resources, edges, ['some_unrelated_group'])).toEqual([]);
  });

  test('an out-of-band controller is never a jump target, agent or not', () => {
    const ilo = host('h3', 'ilo-dl380', { subType: 'ilo', managed: true });
    const iloAgentSvc = agentSvc('a2-svc', 'svc-ilo-dl380-theta-agent', 'a2');
    expect(isJumpTarget(ilo, new Set(['a2-svc']), edges)).toBe(false);
    expect(project([SITE, ilo, iloAgentSvc], [edge('site1', 'h3'), edge('h3', 'a2-svc')], ['god_admin'])).toEqual([]);
  });
});

describe('agent-registered services inherit access from their host', () => {
  const agentHost = host('h1', 'lxc-213', { managed: true, discovery_sources: ['theta-agent'] });
  const agentService = agentSvc('a1-svc', 'svc-lxc-213-theta-agent', 'a1');
  const emby = svc('s1', 'svc-lxc-213-systemd-emby-server', { hostId: 'h1', managed: true, discovery_sources: ['theta-agent'] });
  const resources = [SITE, agentHost, agentService, emby];
  const edges = [edge('site1', 'h1'), edge('h1', 'a1-svc'), edge('h1', 's1')];

  // The theta-agent service is in the same boat as the units it reports: it
  // is a node on the host, not an access boundary of its own, so it inherits
  // rather than minting a group pair per enrolled machine.
  test('reaching the host reaches its registered services and its agent', () => {
    expect(project(resources, edges, ['god_admin'])).toEqual(
      ['lxc-213', 'svc-lxc-213-systemd-emby-server', 'svc-lxc-213-theta-agent']);
  });

  test('not reaching the host does not reach its services', () => {
    expect(project(resources, edges, ['nobody'])).toEqual([]);
  });

  test('the parent edge is used when hostId is missing', () => {
    const orphan = svc('s2', 'svc-legacy', { managed: true, discovery_sources: ['theta-agent'] });
    const out = project([SITE, agentHost, agentService, orphan], [edge('site1', 'h1'), edge('h1', 'a1-svc'), edge('h1', 's2')], ['god_admin']);
    expect(out).toContain('svc-legacy');
  });

  test('a hand-created service is NOT an inheritor and keeps needing its grant', () => {
    const stackSvc = svc('s3', 'sso-manager-718it', { subType: 'web' });
    expect(templateFor(stackSvc).inheritsHost).toBe(false);
    const out = project([SITE, agentHost, agentService, stackSvc], [edge('site1', 'h1'), edge('h1', 'a1-svc'), edge('h1', 's3')], ['god_admin']);
    expect(out).not.toContain('sso-manager-718it');
  });
});

describe('the catalog rule is unchanged', () => {
  test('discovered but never promoted stays out, even for a global admin', () => {
    const unpromoted = host('h9', 'lxc-777', { discovery_sources: ['proxmox-718'] });
    const unpromotedAgentSvc = agentSvc('a9-svc', 'svc-lxc-777-theta-agent', 'a9');
    expect(project([SITE, unpromoted, unpromotedAgentSvc], [edge('site1', 'h9'), edge('h9', 'a9-svc')], ['god_admin'])).toEqual([]);
  });

  test('isPublic still grants without any group', () => {
    const pub = svc('s9', 'status-page', { subType: 'web', isPublic: true });
    expect(project([SITE, pub], [edge('site1', 's9')], [])).toEqual(['status-page']);
  });
});

describe('the site walk', () => {
  test('resolves the site through intermediate hosts', () => {
    const hv = host('hv', 'pve-node-0', { subType: 'hypervisor', managed: true });
    const guest = host('g', 'lxc-213', { subType: 'lxc', managed: true, discovery_sources: ['theta-agent'] });
    const guestAgentSvc = agentSvc('a1-svc', 'svc-lxc-213-theta-agent', 'a1');
    const out = project([SITE, hv, guest, guestAgentSvc], [edge('site1', 'hv'), edge('hv', 'g'), edge('g', 'a1-svc')], ['site_718it_hosts_access']);
    expect(out).toContain('lxc-213');
  });

  test('a parent cycle terminates instead of hanging', () => {
    const a = host('a', 'a', { managed: true });
    const b = host('b', 'b', { managed: true });
    const aAgentSvc = agentSvc('x-svc-a', 'svc-a-theta-agent', 'x');
    const bAgentSvc = agentSvc('x-svc-b', 'svc-b-theta-agent', 'x');
    const agents = [agent('x', 'x-svc-a'), agent('x2', 'x-svc-b')];
    // god_admin reaches both agent hosts and, by inheritance, both agent
    // services; the cycle in parent edges must not hang.
    const out = project(
      [a, b, aAgentSvc, bAgentSvc],
      [edge('a', 'b'), edge('b', 'a'), edge('a', 'x-svc-a'), edge('b', 'x-svc-b')],
      ['god_admin'], [], agents);
    expect(out.sort()).toEqual(['a', 'b', 'svc-a-theta-agent', 'svc-b-theta-agent']);
  });
});

describe('access does not outlive the enrolment', () => {
  const agentHost = host('h1', 'lxc-213', { managed: true, discovery_sources: ['theta-agent'] });
  const agentService = agentSvc('a1-svc', 'svc-lxc-213-theta-agent', 'a1');
  const emby = svc('s1', 'svc-emby', { hostId: 'h1', managed: true, discovery_sources: ['theta-agent'] });
  const resources = [SITE, agentHost, agentService, emby];
  const edges = [edge('site1', 'h1'), edge('h1', 'a1-svc'), edge('h1', 's1')];

  test('a revoked agent stops granting access to its host and its services', () => {
    const live = [agent('a1', 'a1-svc')];
    expect(project(resources, edges, ['god_admin'], [], live))
      .toEqual(['lxc-213', 'svc-emby', 'svc-lxc-213-theta-agent']);
    // Revoked: the host stops qualifying, and so does everything inheriting
    // from it -- including the agent's own service resource.
    expect(project(resources, edges, ['god_admin'], [], [])).toEqual([]);
  });
});
