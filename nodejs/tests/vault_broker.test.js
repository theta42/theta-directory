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

const baoConf = require('@simpleworkjs/bao-conf');
const vaultBroker = require('../utils/vault_broker');

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
