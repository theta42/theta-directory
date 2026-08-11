'use strict';

let mockBaoStore = new Map();
jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(async (path) => mockBaoStore.get(path) || null),
  set: jest.fn(async (path, value) => { mockBaoStore.set(path, value); })
}));

describe('jump_client', () => {
  let jumpClient;
  let originalFetch;
  let mockFetchImpl;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    mockBaoStore = new Map();
    calls = [];
    mockFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', gateways: [] }) });
    originalFetch = global.fetch;
    global.fetch = (...args) => { calls.push(args); return mockFetchImpl(...args); };
    jumpClient = require('../utils/jump_client');
    jumpClient._reset();
    delete process.env.JUMP_INTERNAL_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('reports null count (not zero) when JUMP_INTERNAL_URL is not configured', async () => {
    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBeNull();
    expect(result.note).toMatch(/JUMP_INTERNAL_URL/);
    expect(calls.length).toBe(0);
  });

  test('reports null count when no token is stored in OpenBao', async () => {
    process.env.JUMP_INTERNAL_URL = 'http://jump-host.internal';
    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBeNull();
    expect(result.note).toMatch(/no jump-host API token/);
    expect(calls.length).toBe(0);
  });

  test('returns the real gateway count on success', async () => {
    process.env.JUMP_INTERNAL_URL = 'http://jump-host.internal';
    mockBaoStore.set('integrations/theta-jump', { token: 'jmp_test_token' });
    mockFetchImpl = async () => ({
      ok: true, status: 200,
      json: async () => ({ status: 'ok', gateways: [{ siteSlug: '(self)' }, { siteSlug: 'site-b' }] })
    });

    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBe(2);
    expect(result.note).toBe('ok');
    expect(calls[0][0]).toBe('http://jump-host.internal/api/mesh/gateways');
    expect(calls[0][1].headers.Authorization).toBe('Bearer jmp_test_token');
  });

  test('reports null count on a non-2xx response', async () => {
    process.env.JUMP_INTERNAL_URL = 'http://jump-host.internal';
    mockBaoStore.set('integrations/theta-jump', { token: 'jmp_test_token' });
    mockFetchImpl = async () => ({ ok: false, status: 403 });

    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBeNull();
    expect(result.note).toMatch(/HTTP 403/);
  });

  test('reports a network failure without throwing', async () => {
    process.env.JUMP_INTERNAL_URL = 'http://jump-host.internal';
    mockBaoStore.set('integrations/theta-jump', { token: 'jmp_test_token' });
    mockFetchImpl = async () => { throw new Error('connection refused'); };

    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBeNull();
    expect(result.note).toMatch(/failed: connection refused/);
  });
});
