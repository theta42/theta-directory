'use strict';

// Access projection — who can reach what, and why.
//
// Pure unit tests: the projection takes the resource list and the edge list as
// arguments precisely so this can be exercised without a directory behind it.

const { accessibleResources } = require('../services/access_projection');
const { templateFor, isJumpTarget } = require('../services/subtype_templates');

const SITE = { id: 'site1', kind: 'site', slug: 'site_718it', metadata: {} };

function host(id, slug, metadata = {}) {
  return { id, kind: 'host', slug, name: slug, metadata: { subType: 'linux', ...metadata } };
}
function svc(id, slug, metadata = {}) {
  return { id, kind: 'service', slug, name: slug, metadata: { subType: 'systemd', ...metadata } };
}
const edge = (parentId, childId) => ({ parentId, childId, relation: 'hosts' });

// Every agent in these fixtures is a live enrolment unless a test says
// otherwise. accessibleResources requires the live set explicitly -- a stale
// metadata.agentId left behind by a revoked agent must not keep granting
// access.
function project(resources, edges, groups, grantedIds = [], agentIds = ['a1', 'a2', 'a9', 'x']) {
  return accessibleResources(resources, edges, {
    groupIds: new Set(grantedIds), memberOf: groups, activeAgentIds: new Set(agentIds)
  }).map(r => r.slug).sort();
}

describe('agent-enrolled hosts are jump targets without a per-host grant', () => {
  // The report: "I only see theta-suite-718it as a jump target. How do you add
  // other targets? Any linux host with the theta-agent installed should
  // automatically be a target."
  const agentHost = host('h1', 'lxc-213', { agentId: 'a1', managed: true, discovery_sources: ['theta-agent'] });
  const plainHost = host('h2', 'lxc-999', { managed: true, discovery_sources: ['proxmox-718'] });
  const resources = [SITE, agentHost, plainHost];
  const edges = [edge('site1', 'h1'), edge('site1', 'h2')];

  test('a global admin reaches every agent host, with no ResourceGroup rows at all', () => {
    expect(project(resources, edges, ['god_admin'])).toContain('lxc-213');
  });

  test('the site aggregate grants it too', () => {
    expect(project(resources, edges, ['site_718it_hosts_access'])).toContain('lxc-213');
  });

  test('a host WITHOUT an agent still needs an explicit grant', () => {
    // The rule is "the agent is already proof of management", not "admins get
    // everything" -- a discovered-but-unagented machine is unchanged.
    expect(project(resources, edges, ['god_admin'])).not.toContain('lxc-999');
    expect(project(resources, edges, ['god_admin'], ['h2'])).toContain('lxc-999');
  });

  test('a user with no relevant groups reaches nothing', () => {
    expect(project(resources, edges, ['some_unrelated_group'])).toEqual([]);
  });

  test('an out-of-band controller is never a jump target, agent or not', () => {
    const ilo = host('h3', 'ilo-dl380', { subType: 'ilo', agentId: 'a2', managed: true });
    expect(isJumpTarget(ilo, new Set(['a2']))).toBe(false);
    expect(project([SITE, ilo], [edge('site1', 'h3')], ['god_admin'])).toEqual([]);
  });
});

describe('agent-registered services inherit access from their host', () => {
  // The report: "Services do not need LDAP groups." A systemd unit is not an
  // access boundary; whoever administers the host administers its units.
  const agentHost = host('h1', 'lxc-213', { agentId: 'a1', managed: true, discovery_sources: ['theta-agent'] });
  const emby = svc('s1', 'svc-lxc-213-systemd-emby-server',
    { agentId: 'a1', hostId: 'h1', managed: true, discovery_sources: ['theta-agent'] });
  const resources = [SITE, agentHost, emby];
  const edges = [edge('site1', 'h1'), edge('h1', 's1')];

  test('reaching the host reaches its registered services', () => {
    expect(project(resources, edges, ['god_admin'])).toEqual(
      ['lxc-213', 'svc-lxc-213-systemd-emby-server']);
  });

  test('not reaching the host does not reach its services', () => {
    expect(project(resources, edges, ['nobody'])).toEqual([]);
  });

  test('the parent edge is used when hostId is missing', () => {
    const orphan = svc('s2', 'svc-legacy', { agentId: 'a1', managed: true, discovery_sources: ['theta-agent'] });
    const out = project([SITE, agentHost, orphan], [edge('site1', 'h1'), edge('h1', 's2')], ['god_admin']);
    expect(out).toContain('svc-legacy');
  });

  test('a hand-created service is NOT an inheritor and keeps needing its grant', () => {
    // sso-manager-718it and friends are catalog entries an operator modelled;
    // silently widening who can reach them would be a security change.
    const stackSvc = svc('s3', 'sso-manager-718it', { subType: 'web' });
    expect(templateFor(stackSvc).inheritsHost).toBe(false);
    const out = project([SITE, agentHost, stackSvc], [edge('site1', 'h1'), edge('h1', 's3')], ['god_admin']);
    expect(out).not.toContain('sso-manager-718it');
  });
});

describe('the catalog rule is unchanged', () => {
  test('discovered but never promoted stays out, even for a global admin', () => {
    const unpromoted = host('h9', 'lxc-777', { agentId: 'a9', discovery_sources: ['proxmox-718'] });
    expect(project([SITE, unpromoted], [edge('site1', 'h9')], ['god_admin'])).toEqual([]);
  });

  test('isPublic still grants without any group', () => {
    const pub = svc('s9', 'status-page', { subType: 'web', isPublic: true });
    expect(project([SITE, pub], [edge('site1', 's9')], [])).toEqual(['status-page']);
  });
});

describe('the site walk', () => {
  test('resolves the site through intermediate hosts', () => {
    // site -> hypervisor -> guest. The aggregate is keyed on the SITE, so a
    // guest two hops down must still resolve to site_718it.
    const hv = host('hv', 'pve-node-0', { subType: 'hypervisor', managed: true });
    const guest = host('g', 'lxc-213', { subType: 'lxc', agentId: 'a1', managed: true, discovery_sources: ['theta-agent'] });
    const out = project([SITE, hv, guest], [edge('site1', 'hv'), edge('hv', 'g')], ['site_718it_hosts_access']);
    expect(out).toContain('lxc-213');
  });

  test('a parent cycle terminates instead of hanging', () => {
    const a = host('a', 'a', { agentId: 'x', managed: true });
    const b = host('b', 'b', { agentId: 'x', managed: true });
    // hasPermission still answers for god_admin without a site, so the result
    // is defined; the point is that this returns at all.
    expect(project([a, b], [edge('a', 'b'), edge('b', 'a')], ['god_admin']).length).toBe(2);
  });
});

describe('access does not outlive the enrolment', () => {
  // metadata.agentId is NOT cleared when an agent is revoked or deleted, so the
  // projection is handed the set of agents that are still enrolled rather than
  // trusting the field.
  const agentHost = host('h1', 'lxc-213', { agentId: 'a1', managed: true, discovery_sources: ['theta-agent'] });
  const emby = svc('s1', 'svc-emby', { agentId: 'a1', hostId: 'h1', managed: true, discovery_sources: ['theta-agent'] });
  const resources = [SITE, agentHost, emby];
  const edges = [edge('site1', 'h1'), edge('h1', 's1')];

  test('a revoked agent stops granting access to its host and its services', () => {
    expect(project(resources, edges, ['god_admin'], [], ['a1'])).toEqual(['lxc-213', 'svc-emby']);
    expect(project(resources, edges, ['god_admin'], [], [])).toEqual([]);
  });

  test('an omitted live-agent set grants nothing through the agent rule', () => {
    // A security predicate must not default to permissive when its input is
    // missing.
    const out = accessibleResources(resources, edges, { groupIds: new Set(), memberOf: ['god_admin'] });
    expect(out).toEqual([]);
  });
});
