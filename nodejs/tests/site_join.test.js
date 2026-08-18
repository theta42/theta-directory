'use strict';

const {
  scalarResource, scalarEdge, importDirectory, ldapAddArgs, baseDnFrom, siteIsFresh,
  REPLICATED_FROM, LOCALLY_OWNED
} = require('../utils/site_join');

// In-memory model stubs so importDirectory can be exercised without a DB.
//
// These deliberately mirror @simpleworkjs/orm's REAL shape: statics are only
// list/get/create, while update/delete are INSTANCE methods on the returned
// rows (lib/base.js). The previous version of this stub exposed
// `Resource.update(id, data)` and `ResourceEdge.delete(id)` as statics, which
// the ORM has never had — so these tests passed green while the production
// code path threw "is not a function" into a swallowing catch and silently
// skipped every resource update and every edge deletion. A stub that is more
// permissive than the real model doesn't test the code, it hides it. The
// contract test at the bottom of this file pins the shape to the real ORM so
// this can't drift back.
function makeStore() {
  const rows = [];
  const edges = [];

  const asRow = (store, data) => {
    const row = { ...data };
    // writable/configurable like real class prototype methods, so a caller can
    // wrap them (the ordering test below does exactly that).
    Object.defineProperty(row, 'update', {
      enumerable: false, writable: true, configurable: true,
      value: async (patch) => { Object.assign(row, patch); return row; }
    });
    Object.defineProperty(row, 'delete', {
      enumerable: false, writable: true, configurable: true,
      value: async () => {
        const i = store.indexOf(row);
        if (i >= 0) store.splice(i, 1);
      }
    });
    return row;
  };

  return {
    Resource: {
      // Returns the live instances, as the ORM does — callers mutate through
      // row.update(), so handing back detached copies would silently drop
      // every write.
      list: async () => rows.slice(),
      create: async (d) => { const row = asRow(rows, d); rows.push(row); return row; },
      get rows() { return rows; }
    },
    ResourceEdge: {
      list: async () => edges.slice(),
      create: async (d) => { const row = asRow(edges, d); edges.push(row); return row; },
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

test('importDirectory removes edges the master no longer has and adds the new ones', async () => {
  const s = makeStore();
  // Both endpoints are rows a PREVIOUS import replicated here (the stamp), so
  // the master governs the edge between them. host_old has since been deleted
  // upstream, which is why it is absent from the export below.
  await s.Resource.create({ id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: { [REPLICATED_FROM]: 'site-hq' } });
  await s.Resource.create({ id: 'r2', kind: 'host', name: 'old', slug: 'host_old', metadata: { [REPLICATED_FROM]: 'site-hq' } });
  await s.ResourceEdge.create({ id: 'stale', parentId: 'r1', childId: 'r2', relation: 'contains' });

  const exportData = {
    resources: [
      { id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: {} },
      { id: 'r3', kind: 'host', name: 'new', slug: 'host_new', metadata: {} }
    ],
    edges: [{ id: 'e9', parentId: 'r1', childId: 'r3', relation: 'contains' }]
  };

  const res = await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  const pairs = s.ResourceEdge.rows.map(e => `${e.parentId}->${e.childId}`);
  expect(pairs).toEqual(['r1->r3']);
  expect(res.edgesRemoved).toBe(1);
  expect(res.edgeCount).toBe(1);
});

// The whole point of the create-then-remove ordering: an import interrupted
// partway must never leave the spoke with FEWER edges than it should have.
test('importDirectory adds every desired edge before removing any stale one', async () => {
  const s = makeStore();
  await s.Resource.create({ id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: { [REPLICATED_FROM]: 'site-hq' } });
  await s.Resource.create({ id: 'r2', kind: 'host', name: 'keep', slug: 'host_keep', metadata: { [REPLICATED_FROM]: 'site-hq' } });
  await s.ResourceEdge.create({ id: 'stale', parentId: 'r1', childId: 'r2', relation: 'contains' });

  const order = [];
  const realCreate = s.ResourceEdge.create;
  s.ResourceEdge.create = async (d) => { order.push('create'); return realCreate(d); };
  const origList = s.ResourceEdge.list;
  s.ResourceEdge.list = async () => {
    const rows = await origList();
    return rows.map((row) => {
      const wrapped = Object.create(row);
      wrapped.delete = async () => { order.push('delete'); return row.delete(); };
      return wrapped;
    });
  };

  await importDirectory({
    Resource: s.Resource,
    ResourceEdge: s.ResourceEdge,
    exportData: {
      resources: [{ id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: {} }],
      edges: [{ id: 'e1', parentId: 'r1', childId: 'r1', relation: 'contains' }]
    }
  });

  expect(order).toEqual(['create', 'delete']);
});

// A spoke's own bootstrap creates resources with locally-generated ids, and
// several slugs (openresty, host_theta-proxy, ...) are identical at every
// site. Adopting the master's edges by raw id wrote rows pointing at ids that
// don't exist locally.
test('importDirectory remaps edge endpoints from master ids onto local ids', async () => {
  const s = makeStore();
  await s.Resource.create({ id: 'local-site', kind: 'site', name: 'S', slug: 'site_s', metadata: {} });
  await s.Resource.create({ id: 'local-proxy', kind: 'service', name: 'proxy', slug: 'openresty', metadata: {} });

  const res = await importDirectory({
    Resource: s.Resource,
    ResourceEdge: s.ResourceEdge,
    exportData: {
      resources: [
        { id: 'master-site', kind: 'site', name: 'S', slug: 'site_s', metadata: {} },
        { id: 'master-proxy', kind: 'service', name: 'proxy', slug: 'openresty', metadata: {} }
      ],
      edges: [{ id: 'e1', parentId: 'master-site', childId: 'master-proxy', relation: 'hosts' }]
    }
  });

  expect(res.edgeCount).toBe(1);
  expect(s.ResourceEdge.rows[0].parentId).toBe('local-site');
  expect(s.ResourceEdge.rows[0].childId).toBe('local-proxy');
});

test('importDirectory skips edges whose endpoints do not exist locally', async () => {
  const s = makeStore();
  const res = await importDirectory({
    Resource: s.Resource,
    ResourceEdge: s.ResourceEdge,
    exportData: {
      resources: [],
      edges: [{ id: 'e1', parentId: 'ghost-a', childId: 'ghost-b', relation: 'hosts' }]
    }
  });

  expect(res.edgesSkipped).toBe(1);
  expect(s.ResourceEdge.rows.length).toBe(0);
});

// Re-running an import must be a no-op, not a churn of delete+recreate.
test('importDirectory converges: a second identical import changes nothing', async () => {
  const s = makeStore();
  const exportData = {
    resources: [
      { id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: {} },
      { id: 'r2', kind: 'host', name: 'h', slug: 'host_h', metadata: {} }
    ],
    edges: [{ id: 'e1', parentId: 'r1', childId: 'r2', relation: 'contains' }]
  };

  await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });
  const first = s.ResourceEdge.rows[0];
  const second = await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  expect(s.ResourceEdge.rows.length).toBe(1);
  expect(s.ResourceEdge.rows[0]).toBe(first); // same row object — never deleted/recreated
  expect(second.edgesRemoved).toBe(0);
});

// ── Locally-owned rows (see LOCALLY_OWNED in utils/site_join.js) ─────────────
//
// Every site's bootstrap seeds the SAME fixed service slugs, and the master
// auto-creates a site row for each spoke under the slug that spoke's own
// bootstrap already used. Upserting those by slug rewrote a spoke's own
// records with the master's.

test('importDirectory keeps a locally-owned row\'s own metadata when the master shares its slug', async () => {
  const s = makeStore();
  await s.Resource.create({
    id: 'local-sso', kind: 'service', name: 'SSO Manager', slug: 'sso-manager',
    metadata: { address: 'https://sso.branch.example.com', port: 3001 }
  });

  const exportData = {
    siteSlug: 'site-hq',
    resources: [{
      id: 'master-sso', kind: 'service', name: 'SSO Manager', slug: 'sso-manager',
      metadata: { address: 'https://sso.hq.example.com', port: 3001, icon: 'mdi:shield-account' }
    }],
    edges: []
  };

  await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  const row = s.Resource.rows.find(r => r.slug === 'sso-manager');
  // This site's own address survives...
  expect(row.metadata.address).toBe('https://sso.branch.example.com');
  // ...a key only the master had is still adopted...
  expect(row.metadata.icon).toBe('mdi:shield-account');
  // ...and the row is marked so the NEXT import still knows it is ours.
  expect(row.metadata[LOCALLY_OWNED]).toBe(true);
  expect(row.metadata[REPLICATED_FROM]).toBeUndefined();
});

test('importDirectory never clears isCurrentSite on this site\'s own site row', async () => {
  const s = makeStore();
  await s.Resource.create({
    id: 'local-site', kind: 'site', name: 'Branch', slug: 'site_branch',
    metadata: { isCurrentSite: true }
  });

  const exportData = {
    siteSlug: 'site-hq',
    resources: [
      // What the master's POST /api/site/spokes auto-creates for this spoke.
      { id: 'm-branch', kind: 'site', name: 'branch', slug: 'site_branch', metadata: { isCurrentSite: false, isSpoke: true } },
      { id: 'm-hq', kind: 'site', name: 'HQ', slug: 'site_hq', metadata: { isCurrentSite: true } }
    ],
    edges: []
  };

  await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });
  await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  const mine = s.Resource.rows.find(r => r.slug === 'site_branch');
  expect(mine.metadata.isCurrentSite).toBe(true);
  expect(mine.metadata.isSpoke).toBe(true); // still adopts what only the master knew
});

test('importDirectory does not delete a locally-owned row the master dropped', async () => {
  const s = makeStore();
  await s.Resource.create({ id: 'local-sso', kind: 'service', name: 'SSO', slug: 'sso-manager', metadata: {} });

  // First import: the master has it too, so the row is marked locally-owned.
  await importDirectory({
    Resource: s.Resource, ResourceEdge: s.ResourceEdge,
    exportData: { siteSlug: 'site-hq', resources: [{ id: 'm', kind: 'service', name: 'SSO', slug: 'sso-manager', metadata: {} }], edges: [] }
  });
  // Second import: the master no longer has it. Ours must survive.
  const res = await importDirectory({
    Resource: s.Resource, ResourceEdge: s.ResourceEdge,
    exportData: { siteSlug: 'site-hq', resources: [], edges: [] }
  });

  expect(s.Resource.rows.find(r => r.slug === 'sso-manager')).toBeTruthy();
  expect(res.resourcesRemoved).toBe(0);
});

// The bug that quietly emptied a spoke's directory tree: the removal pass had
// no provenance check, so every resync deleted every local edge the master's
// export did not contain.
test('importDirectory keeps edges the master has no say over', async () => {
  const s = makeStore();
  await s.Resource.create({ id: 'my-site', kind: 'site', name: 'Branch', slug: 'site_branch', metadata: { isCurrentSite: true } });
  await s.Resource.create({ id: 'my-host', kind: 'host', name: 'branchbox', slug: 'host_branchbox', metadata: {} });
  await s.Resource.create({ id: 'my-sso', kind: 'service', name: 'SSO', slug: 'sso-manager', metadata: {} });
  // This site's own tree: site -> host -> service.
  await s.ResourceEdge.create({ id: 'e-a', parentId: 'my-site', childId: 'my-host', relation: 'contains' });
  await s.ResourceEdge.create({ id: 'e-b', parentId: 'my-host', childId: 'my-sso', relation: 'hosts' });

  // The master's export knows nothing about this site's host, and parents its
  // OWN sso-manager under its OWN host.
  const exportData = {
    siteSlug: 'site-hq',
    resources: [
      { id: 'm-site', kind: 'site', name: 'HQ', slug: 'site_hq', metadata: {} },
      { id: 'm-host', kind: 'host', name: 'hqbox', slug: 'host_hqbox', metadata: {} },
      { id: 'm-sso', kind: 'service', name: 'SSO', slug: 'sso-manager', metadata: {} }
    ],
    edges: [
      { id: 'me1', parentId: 'm-site', childId: 'm-host', relation: 'contains' },
      { id: 'me2', parentId: 'm-host', childId: 'm-sso', relation: 'hosts' }
    ]
  };

  const res = await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });

  const pairs = s.ResourceEdge.rows.map(e => `${e.parentId}->${e.childId}`);
  expect(pairs).toContain('my-site->my-host');
  expect(pairs).toContain('my-host->my-sso');
  expect(res.edgesRemoved).toBe(0);
  expect(res.edgesKeptLocal).toBeGreaterThan(0);
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
  // argv[0] is the command itself. Omitting it made the caller spawn "-c",
  // which is how the LDAP import silently never ran; assert it explicitly.
  expect(a[0]).toBe('ldapadd');
  expect(a).toContain('-c');
  expect(a).toContain('-x');
  expect(a).toContain('cn=admin,dc=example,dc=com');
  expect(a).toContain('/tmp/x.ldif');
  expect(a.indexOf('-D') < a.indexOf('-w')).toBe(true);
});

// slapcat emits operational attributes; ldapadd rejects every entry carrying
// one ("no user modification allowed"), which is half of why the LDAP side of
// a join never worked.
test('stripOperationalAttrs removes slapcat-only attributes', () => {
  const { stripOperationalAttrs } = require('../utils/site_join');
  const ldif = [
    'dn: uid=bob,ou=people,dc=e2e,dc=test',
    'objectClass: inetOrgPerson',
    'uid: bob',
    'structuralObjectClass: inetOrgPerson',
    'entryUUID: 7c1f7a1e-0000-1000-8000-000000000000',
    'creatorsName: cn=admin,dc=e2e,dc=test',
    'createTimestamp: 20260101000000Z',
    'entryCSN: 20260101000000.000000Z#000000#001#000000',
    'modifiersName: cn=admin,dc=e2e,dc=test',
    'modifyTimestamp: 20260101000000Z',
    ''
  ].join('\n');

  const out = stripOperationalAttrs(ldif);
  expect(out).toContain('dn: uid=bob,ou=people,dc=e2e,dc=test');
  expect(out).toContain('uid: bob');
  expect(out).toContain('objectClass: inetOrgPerson');
  for (const attr of ['structuralObjectClass', 'entryUUID', 'creatorsName', 'createTimestamp', 'entryCSN', 'modifiersName', 'modifyTimestamp']) {
    expect(out).not.toContain(attr + ':');
  }
});

test('stripOperationalAttrs drops folded continuation lines with their attribute', () => {
  const { stripOperationalAttrs } = require('../utils/site_join');
  const ldif = [
    'dn: uid=bob,ou=people,dc=e2e,dc=test',
    'entryCSN: 20260101000000.000000Z#000000#001',
    ' #000000',
    'uid: bob',
    'description: a very long value that slapcat',
    '  folded across two lines',
    ''
  ].join('\n');

  const out = stripOperationalAttrs(ldif);
  expect(out).not.toContain('#000000');
  expect(out).toContain('uid: bob');
  // A folded line belonging to a KEPT attribute must survive.
  expect(out).toContain('  folded across two lines');
});

test('stripOperationalAttrs keeps base64 (::) attribute values', () => {
  const { stripOperationalAttrs } = require('../utils/site_join');
  const ldif = 'dn: uid=b,dc=e2e,dc=test\nuserPassword:: e1NTSEF9eHl6\nentryUUID:: abcd\n';
  const out = stripOperationalAttrs(ldif);
  expect(out).toContain('userPassword:: e1NTSEF9eHl6');
  expect(out).not.toContain('entryUUID');
});

// Every spoke already holds its own root/admin/ou entries, so "Already
// exists" is the expected outcome for those and must not read as a failure.
test('summarizeLdapAddResult treats only-Already-exists as a successful import', () => {
  const { summarizeLdapAddResult } = require('../utils/site_join');
  const stderr = 'ldap_add: Already exists (68)\nldap_add: Already exists (68)\n';
  const r = summarizeLdapAddResult(stderr);
  expect(r.ok).toBe(true);
  expect(r.note).toMatch(/^imported/);
  expect(r.note).toContain('2 entries already present');
});

test('summarizeLdapAddResult reports real rejections with their reason', () => {
  const { summarizeLdapAddResult } = require('../utils/site_join');
  const stderr = [
    'ldap_add: Already exists (68)',
    'ldap_add: Constraint violation (19)',
    '\tadditional info: memberOf: no user modification allowed',
    'ldap_add: Constraint violation (19)'
  ].join('\n');
  const r = summarizeLdapAddResult(stderr);
  expect(r.ok).toBe(false);
  expect(r.note).toMatch(/^partial: 2 of 3 entries rejected/);
  expect(r.note).toContain('Constraint violation (19)');
});

test('summarizeLdapAddResult falls through when it cannot parse anything', () => {
  const { summarizeLdapAddResult } = require('../utils/site_join');
  expect(summarizeLdapAddResult('ldapadd: command not found')).toEqual({ ok: false, note: null });
  expect(summarizeLdapAddResult('')).toEqual({ ok: false, note: null });
});

test('memberOf is stripped as an operational attribute', () => {
  const { stripOperationalAttrs } = require('../utils/site_join');
  const out = stripOperationalAttrs('dn: uid=b,dc=e2e,dc=test\nuid: b\nmemberOf: cn=g,ou=groups,dc=e2e,dc=test\n');
  expect(out).toContain('uid: b');
  expect(out).not.toContain('memberOf');
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

// Deletions on the master have to reach the spoke, but a spoke also holds
// resources of its own (its bootstrap seeds a site, a host and services the
// master has never heard of). Only rows this import path adopted may be
// removed.
test('importDirectory removes replicated resources the master deleted', async () => {
  const s = makeStore();
  const exportData = {
    siteSlug: 'site_main',
    resources: [
      { id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: {} },
      { id: 'r2', kind: 'host', name: 'doomed', slug: 'host_doomed', metadata: {} }
    ],
    edges: []
  };
  await importDirectory({ Resource: s.Resource, ResourceEdge: s.ResourceEdge, exportData });
  expect(s.Resource.rows.map(r => r.slug).sort()).toEqual(['host_doomed', 'site_s']);

  // Master drops host_doomed.
  const res = await importDirectory({
    Resource: s.Resource,
    ResourceEdge: s.ResourceEdge,
    exportData: { ...exportData, resources: [exportData.resources[0]] }
  });

  expect(res.resourcesRemoved).toBe(1);
  expect(s.Resource.rows.map(r => r.slug)).toEqual(['site_s']);
});

test('importDirectory never deletes the spoke\'s own local resources', async () => {
  const s = makeStore();
  await s.Resource.create({ id: 'own1', kind: 'site', name: 'My Site', slug: 'site_local', metadata: {} });
  await s.Resource.create({ id: 'own2', kind: 'host', name: 'My Host', slug: 'host_local', metadata: {} });

  const res = await importDirectory({
    Resource: s.Resource,
    ResourceEdge: s.ResourceEdge,
    exportData: {
      siteSlug: 'site_main',
      resources: [{ id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: {} }],
      edges: []
    }
  });

  expect(res.resourcesRemoved).toBe(0);
  expect(s.Resource.rows.map(r => r.slug).sort()).toEqual(['host_local', 'site_local', 'site_s']);
});

test('replicated resources carry a provenance stamp', async () => {
  const { REPLICATED_FROM } = require('../utils/site_join');
  const s = makeStore();
  await importDirectory({
    Resource: s.Resource,
    ResourceEdge: s.ResourceEdge,
    exportData: {
      siteSlug: 'site_main',
      resources: [{ id: 'r1', kind: 'site', name: 'S', slug: 'site_s', metadata: { keep: 'me' } }],
      edges: []
    }
  });
  expect(s.Resource.rows[0].metadata[REPLICATED_FROM]).toBe('site_main');
  expect(s.Resource.rows[0].metadata.keep).toBe('me');
});

// Contract test: pins the stub shape above to the real ORM. If a future ORM
// release adds static update/delete (or drops the instance ones), this fails
// loudly instead of letting the stubs drift back into being more permissive
// than production — which is precisely how the silent no-op shipped.
test('the ORM base model has no static update/delete, only instance ones', () => {
  const { Model } = require('@simpleworkjs/orm');
  expect(typeof Model.update).toBe('undefined');
  expect(typeof Model.delete).toBe('undefined');
  expect(typeof Model.prototype.update).toBe('function');
  expect(typeof Model.prototype.delete).toBe('function');
  // The statics importDirectory does rely on:
  expect(typeof Model.list).toBe('function');
  expect(typeof Model.create).toBe('function');
});

test('the importDirectory stubs match that contract', async () => {
  const s = makeStore();
  expect(typeof s.Resource.update).toBe('undefined');
  expect(typeof s.ResourceEdge.delete).toBe('undefined');
  const row = await s.Resource.create({ id: 'x', slug: 'x' });
  expect(typeof row.update).toBe('function');
  const edge = await s.ResourceEdge.create({ parentId: 'a', childId: 'b', relation: 'r' });
  expect(typeof edge.delete).toBe('function');
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
