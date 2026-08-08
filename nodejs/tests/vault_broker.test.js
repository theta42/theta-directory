'use strict';

jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
  request: jest.fn(),
}));

jest.mock('redis', () => ({
  createClient: () => ({
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(),
  })
}));

// In-memory stand-ins for the ORM-backed models so mintAppToken/renewAppTokens
// can run without a database.
jest.mock('../models/shared_secret', () => ({
  SharedSecret: { list: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../models/shared_secret_grant', () => ({
  SharedSecretGrant: { listForGrantee: jest.fn().mockResolvedValue([]) },
}));
jest.mock('../models/vault_app_token', () => {
  const rows = [];
  const VaultAppToken = {
    _rows: rows,
    list: jest.fn(async () => rows),
    getByName: jest.fn(async (name) => rows.find(r => r.name === name) || null),
    create: jest.fn(async (data) => {
      const row = {
        ...data,
        update: jest.fn(async function (patch) { Object.assign(this, patch); }),
        delete: jest.fn(async function () { rows.splice(rows.indexOf(this), 1); }),
      };
      rows.push(row);
      return row;
    }),
  };
  return { VaultAppToken };
});

const baoConf = require('@simpleworkjs/bao-conf');
const vaultBroker = require('../utils/vault_broker');
const { VaultAppToken } = require('../models/vault_app_token');

describe('vault_broker admin policy', () => {
  beforeEach(() => {
    baoConf.request.mockReset();
  });

  test('getOrCreateAdminToken ensures sso-admin policy with list capabilities on metadata', async () => {
    baoConf.request.mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path === 'sys/policies/acl/sso-admin') {
        return { status: 404, text: async () => '' };
      }
      if (method === 'PUT' && path === 'sys/policies/acl/sso-admin') {
        expect(body.policy).toContain('path "secret/metadata" { capabilities = ["create", "read", "update", "delete", "list"] }');
        expect(body.policy).toContain('path "secret/metadata/" { capabilities = ["create", "read", "update", "delete", "list"] }');
        return { status: 204, ok: true };
      }
      if (method === 'POST' && path === 'auth/token/create/sso-broker') {
        return {
          ok: true,
          json: async () => ({ auth: { client_token: 'test-admin-token', lease_duration: 3600 } })
        };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    });

    const token = await vaultBroker.getOrCreateAdminToken('adminuser');
    expect(token).toBe('test-admin-token');
    expect(baoConf.request).toHaveBeenCalledWith('PUT', 'sys/policies/acl/sso-admin', expect.objectContaining({
      policy: expect.stringContaining('path "secret/metadata/"')
    }));
  });
});

describe('app token lifecycle (accessor storage + renewal)', () => {
  beforeEach(() => {
    baoConf.request.mockReset();
    VaultAppToken._rows.length = 0;
  });

  function mockBao({ mintAccessor = 'acc-1', renewOk = true } = {}) {
    baoConf.request.mockImplementation(async (method, path, body) => {
      if (path.startsWith('sys/policies/acl/')) {
        if (method === 'GET') return { status: 404, text: async () => '' };
        return { status: 204, ok: true };
      }
      if (path === 'auth/token/create/sso-app') {
        return { ok: true, json: async () => ({ auth: { client_token: 'app-tok', accessor: mintAccessor, lease_duration: 2764800 } }) };
      }
      if (path === 'auth/token/renew-accessor') {
        return renewOk ? { ok: true, json: async () => ({}) } : { ok: false, status: 400, text: async () => 'invalid accessor' };
      }
      if (path === 'auth/token/revoke-accessor') {
        return { ok: true, status: 204, text: async () => '' };
      }
      return { status: 200, ok: true, json: async () => ({}) };
    });
  }

  test('mintAppToken stores the accessor; re-mint revokes the old accessor and replaces the row', async () => {
    mockBao({ mintAccessor: 'acc-old' });
    await vaultBroker.mintAppToken('demo', 'adminuser');
    expect(VaultAppToken._rows).toHaveLength(1);
    expect(VaultAppToken._rows[0]).toMatchObject({ name: 'demo', accessor: 'acc-old', created_by: 'adminuser' });

    mockBao({ mintAccessor: 'acc-new' });
    await vaultBroker.mintAppToken('demo', 'adminuser');
    expect(baoConf.request).toHaveBeenCalledWith('POST', 'auth/token/revoke-accessor', { accessor: 'acc-old' });
    expect(VaultAppToken._rows).toHaveLength(1);
    expect(VaultAppToken._rows[0].accessor).toBe('acc-new');
  });

  test('renewAppTokens renews each accessor and stamps lastRenewedAt', async () => {
    mockBao();
    await vaultBroker.mintAppToken('demo', 'adminuser');
    VaultAppToken._rows[0].lastRenewedAt = 0;
    await vaultBroker.renewAppTokens();
    expect(baoConf.request).toHaveBeenCalledWith('POST', 'auth/token/renew-accessor', { accessor: 'acc-1' });
    expect(VaultAppToken._rows[0].lastRenewedAt).toBeGreaterThan(0);
    expect(VaultAppToken._rows[0].lastError).toBeNull();
  });

  test('renewAppTokens records the failure on the row without throwing', async () => {
    mockBao({ renewOk: false });
    await vaultBroker.mintAppToken('demo', 'adminuser');
    await vaultBroker.renewAppTokens();
    expect(VaultAppToken._rows[0].lastError).toMatch(/renew failed \(400\)/);
  });
});

// Real HTTP round-trip through vaultProxy() against an in-process fake OpenBao.
// This exists because the proxy once shipped with a hook shape the installed
// http-proxy-middleware version ignored (v3 `on: { proxyReq }` vs v2
// `onProxyReq`), so NO X-Vault-Token was ever injected and every /api/vault
// request 403'd. A unit test on options can't catch that — only a wire test can.
describe('vaultProxy wire behavior', () => {
  const http = require('http');
  const express = require('express');

  let target; // fake OpenBao
  let seen;   // last request the fake OpenBao received
  let app;    // sso app fragment: scopeGuard stub + vaultProxy
  let server;

  beforeAll((done) => {
    target = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        seen = { method: req.method, url: req.url, headers: req.headers, body };
        res.setHeader('content-type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    target.listen(0, '127.0.0.1', () => {
      process.env.VAULT_ADDR = `http://127.0.0.1:${target.address().port}`;
      jest.resetModules();
      const broker = require('../utils/vault_broker');
      app = express();
      app.use(express.json());
      app.use('/api/vault', (req, res, next) => { req.vaultToken = 'scoped-token-123'; next(); }, broker.vaultProxy());
      server = app.listen(0, '127.0.0.1', done);
    });
  });

  afterAll((done) => {
    server.close(() => target.close(done));
  });

  function call(path, opts = {}) {
    const port = server.address().port;
    return fetch(`http://127.0.0.1:${port}${path}`, opts);
  }

  test('GET list rewrites /api/vault -> /v1, injects X-Vault-Token, strips sso auth headers', async () => {
    const res = await call('/api/vault/secret/metadata/users/alice?list=true', {
      headers: { 'auth-token': 'sso-session-token', authorization: 'Bearer sso_x_y', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    expect(seen.url).toBe('/v1/secret/metadata/users/alice?list=true');
    expect(seen.headers['x-vault-token']).toBe('scoped-token-123');
    expect(seen.headers['auth-token']).toBeUndefined();
    expect(seen.headers['authorization']).toBeUndefined();
  });

  test('POST body survives the express.json + fixRequestBody round-trip', async () => {
    const res = await call('/api/vault/secret/data/users/alice/foo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'auth-token': 'sso-session-token' },
      body: JSON.stringify({ data: { hello: 'world' } }),
    });
    expect(res.status).toBe(200);
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/v1/secret/data/users/alice/foo');
    expect(seen.headers['x-vault-token']).toBe('scoped-token-123');
    expect(JSON.parse(seen.body)).toEqual({ data: { hello: 'world' } });
  });
});
