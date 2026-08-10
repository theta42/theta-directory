'use strict';

const { scalarResource, scalarEdge, importDirectory, ldapAddArgs, baseDnFrom, siteIsFresh } = require('../utils/site_join');

// In-memory model stubs so importDirectory can be exercised without a DB.
function makeStore() {
  const rows = [];
  const edges = [];
  return {
    Resource: {
      list: async () => rows.map(r => ({ ...r })),
      create: async (d) => { rows.push({ ...d }); return { ...d }; },
      update: async (id, d) => {
        const i = rows.findIndex(r => r.id === id);
        if (i >= 0) rows[i] = { ...rows[i], ...d };
        return rows[i];
      },
      get rows() { return rows; }
    },
    ResourceEdge: {
      list: async () => edges.map(e => ({ ...e })),
      create: async (d) => { edges.push({ ...d }); return { ...d }; },
      delete: async (id) => {
        const i = edges.findIndex(e => e.id === id);
        if (i >= 0) edges.splice(i, 1);
      },
      get rows() { return edges; }
    }
  };
}

test('importDirectory creates new resources and edges', async () => {
  const s = makeStore();
  const exportData = {
    resources: [
      { id: 'r1', kind: 'site', name: 'Main Office', slug: 'site_main-office', metadata: { address: '10.0.0.1' } },
      { id: 'r2', kind: 'host', name: 'web01', slug: 'host_web-01', metadata: { ip: '10.0.0.10' } }
    ],
    edges: [{ id: 'e1', parentId: 'r1', childId: 'r2', relation: 'contains' }]
  };

  const res = await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  expect(s.Resource.rows.length).toBe(2);
  expect(s.ResourceEdge.rows.length).toBe(1);
  expect(res.created).toBe(2);
  expect(res.updated).toBe(0);
  expect(res.edgeCount).toBe(1);
  expect(s.Resource.rows[0].slug).toBe('site_main-office');
});

test('importDirectory updates existing resources by slug (master is authoritative)', async () => {
  const s = makeStore();
  await s.Resource.create({ id: 'local1', kind: 'host', name: 'web01', slug: 'host_web-01', metadata: {} });

  const exportData = {
    resources: [
      { id: 'r2', kind: 'host', name: 'web01-new', slug: 'host_web-01', metadata: { ip: '10.0.0.9' } }
    ],
    edges: []
  };

  const res = await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  expect(s.Resource.rows.length).toBe(1); // upsert, not duplicate
  expect(s.Resource.rows[0].name).toBe('web01-new');
  expect(res.updated).toBe(1);
});

test('importDirectory clears stale edges then recreates from master', async () => {
  const s = makeStore();
  await s.Resource.create({ id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: {} });
  await s.Resource.create({ id: 'r2', kind: 'host', name: 'old', slug: 'host_old', metadata: {} });
  await s.ResourceEdge.create({ id: 'stale', parentId: 'r1', childId: 'r2', relation: 'contains' });

  const exportData = {
    resources: [
      { id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: {} },
      { id: 'r3', kind: 'host', name: 'new', slug: 'host_new', metadata: {} }
    ],
    edges: [{ id: 'e9', parentId: 'r1', childId: 'r3', relation: 'contains' }]
  };

  await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  const edgeIds = s.ResourceEdge.rows.map(e => e.id);
  expect(edgeIds).toContain('e9');
  expect(edgeIds).not.toContain('stale');
});

test('scalarResource strips relation fields but keeps metadata', () => {
  const o = scalarResource({
    id: 'x', kind: 'host', name: 'n', slug: 's', metadata: { a: 1 },
    edgesAsParent: [1], edgesAsChild: [2], groups: [3],
    toJSON() { return this; }
  });
  expect(o.edgesAsParent).toBeUndefined();
  expect(o.edgesAsChild).toBeUndefined();
  expect(o.groups).toBeUndefined();
  expect(o.metadata.a).toBe(1);
});

test('scalarEdge keeps parentId/childId/relation', () => {
  const e = scalarEdge({ id: 'e1', parentId: 'p', childId: 'c', relation: 'contains', toJSON() { return this; } });
  expect(e).toEqual({ id: 'e1', parentId: 'p', childId: 'c', relation: 'contains' });
});

test('ldapAddArgs builds a continue-on-error admin bind', () => {
  const a = ldapAddArgs({ bindDN: 'cn=admin,dc=example,dc=com', ldapCred: 'test-bind', ldifFile: '/tmp/x.ldif' });
  expect(a).toContain('-c');
  expect(a).toContain('-x');
  expect(a).toContain('cn=admin,dc=example,dc=com');
  expect(a).toContain('/tmp/x.ldif');
  expect(a.indexOf('-D') < a.indexOf('-w')).toBe(true);
});

test('baseDnFrom prefers stack.ldapBaseDn and falls back to the bind DN', () => {
  expect(baseDnFrom({ stack: { ldapBaseDn: 'dc=stack,dc=com' } })).toBe('dc=stack,dc=com');
  expect(baseDnFrom({ ldap: { bindDN: 'cn=admin,dc=example,dc=com' } })).toBe('dc=example,dc=com');
  expect(baseDnFrom({ ldap: { bindDN: 'cn=admin' } })).toBe('');
});

// The fresh-install guard: only no-users-beyond-admin + no-agents may join.
test('siteIsFresh is true with only the bootstrap admin and no agents', async () => {
  const User = { listDetail: async () => [{ uid: 'admin', isServiceAccount: false }] };
  const Agent = { list: async () => [] };
  expect(await siteIsFresh({ User, Agent })).toBe(true);
});

test('siteIsFresh is false with a second real user', async () => {
  const User = { listDetail: async () => [{ uid: 'admin' }, { uid: 'bob' }] };
  const Agent = { list: async () => [] };
  expect(await siteIsFresh({ User, Agent })).toBe(false);
});

test('siteIsFresh is false with an enrolled agent', async () => {
  const User = { listDetail: async () => [{ uid: 'admin' }] };
  const Agent = { list: async () => [{ id: 'a1' }] };
  expect(await siteIsFresh({ User, Agent })).toBe(false);
});

test('siteIsFresh ignores service accounts', async () => {
  const User = { listDetail: async () => [
    { uid: 'admin' },
    { uid: 'sso-svc', isServiceAccount: true },
    { uid: 'ldapclient', isServiceAccount: true }
  ] };
  const Agent = { list: async () => [] };
  expect(await siteIsFresh({ User, Agent })).toBe(true);
});
