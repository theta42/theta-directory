'use strict';

// POST /api/site/export builds its payload by destructuring one big
// Promise.all. That is positional, and getting it wrong is silent: every
// binding after the mistake takes its neighbour's value, so a spoke joins
// successfully and imports the agent fleet as bao secrets, the API tokens as
// join keys, and an array where the agent signing key should be.
//
// Nothing here checks the CONTENT of any one source -- other tests do that.
// This asserts only that each response field carries the source it is named
// after, which is the single property the destructuring can break.

// slurpLdif shells out to slapcat, which does not exist in the test image and
// (unlike every other source in the Promise.all) is not wrapped in a .catch.
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: (cmd, args, opts, cb) => {
    const done = typeof opts === 'function' ? opts : cb;
    done(null, { stdout: 'dn: dc=test\n', stderr: '' });
  }
}));

const mockJoinKeys = new Map();

jest.mock('../models/site_join_key', () => ({
  SiteJoinKey: {
    authenticate: async (raw) => mockJoinKeys.get(raw) || null
  }
}));

const marker = (name) => [{ __source: name, toJSON() { return { __source: name }; } }];

jest.mock('../models/resource', () => ({
  Resource: { list: async () => [{ __source: 'resources', toJSON: () => ({ __source: 'resources' }) }] },
  ResourceEdge: { list: async () => [{ __source: 'edges', toJSON: () => ({ __source: 'edges' }) }] },
  ENV_RANK: { prod: 3, testing: 2, dev: 1 },
  ENVIRONMENTS: ['prod', 'testing', 'dev']
}));
jest.mock('../models/subtype_template', () => ({
  SubtypeTemplate: { list: async () => [{ __source: 'subtypeTemplates', toJSON: () => ({ __source: 'subtypeTemplates' }) }] }
}));
jest.mock('../models/agent', () => ({
  Agent: { list: async () => [{ __source: 'agents', toReplica: () => ({ __source: 'agents' }) }] },
  AgentJoinKey: { list: async () => [{ __source: 'agentJoinKeys', toReplica: () => ({ __source: 'agentJoinKeys' }) }] }
}));
jest.mock('../models/verification', () => ({
  UserVerification: { listDetail: async () => [{ __source: 'userVerifications' }] }
}));
jest.mock('../models/api_token', () => ({
  ApiToken: { list: async () => [{ __source: 'apiTokens', toReplica: () => ({ __source: 'apiTokens' }) }] }
}));
jest.mock('../models/mesh_client', () => ({
  MeshClient: { list: async () => [{ __source: 'meshClients', toJSON: () => ({ __source: 'meshClients' }) }] },
  MeshExitGrant: { list: async () => [{ __source: 'meshExitGrants', toJSON: () => ({ __source: 'meshExitGrants' }) }] }
}));
jest.mock('../utils/agent_keys', () => ({
  load: async () => ({ privateKeyPem: 'PRIVATE', publicKeyPem: 'PUBLIC' }),
  status: () => ({ available: true })
}));
jest.mock('../utils/mesh_roster', () => ({
  syncFromSpokes: async () => ({ created: 0 }),
  roster: async () => [{ __source: 'meshSites', toJSON: () => ({ __source: 'meshSites' }) }],
  bySiteId: async () => null,
  adoptRoster: async () => ({ adopted: 0 })
}));
jest.mock('../utils/mesh_clients', () => ({
  adoptClients: async () => ({ adopted: 0, grants: 0 })
}));
jest.mock('../utils/site_replicate', () => ({ replicateToSpokes: () => {}, pushResync: () => {} }));
jest.mock('../utils/ldap_reconcile', () => ({ reconcileSoon: () => {} }));
jest.mock('../utils/ldap_replication', () => ({
  nextFreeLdapServerId: async () => 2,
  ldapMeshHost: () => null, ldapHostFor: () => null, ldapHostForSpoke: () => null
}));

const request = require('supertest');
const express = require('express');

let app;
let apiSite;

beforeEach(() => {
  mockJoinKeys.clear();
  jest.resetModules();
  apiSite = require('../routes/api_site');
  // exportSharedBaoSecrets is module-private and wrapped in .catch at the call
  // site; with no OpenBao here it resolves to [] on its own.
  app = express();
  app.use(express.json());
  app.use('/api/site', apiSite);
});

test('every export field carries the source it is named after', async () => {
  mockJoinKeys.set('join-key-abc', { keyPrefix: 'join-key-abc', use_count: 0, update: async () => {} });

  const res = await request(app)
    .post('/api/site/export')
    .set('Authorization', 'Bearer join-key-abc')
    .send({});

  expect(res.status).toBe(200);

  const named = {
    resources: 'resources',
    edges: 'edges',
    meshSites: 'meshSites',
    agents: 'agents',
    agentJoinKeys: 'agentJoinKeys',
    subtypeTemplates: 'subtypeTemplates',
    meshClients: 'meshClients',
    meshExitGrants: 'meshExitGrants',
    userVerifications: 'userVerifications',
    apiTokens: 'apiTokens'
  };
  for (const [field, expected] of Object.entries(named)) {
    expect(Array.isArray(res.body[field])).toBe(true);
    expect(res.body[field].map(x => x.__source)).toEqual([expected]);
  }

  // The signing key is an object, not one of the lists: if a list promise
  // shifts into its slot this is the field that shows it first.
  expect(res.body.signingKey).toEqual({ privateKeyPem: 'PRIVATE', publicKeyPem: 'PUBLIC' });
});
