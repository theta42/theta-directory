'use strict';

let mockBaoStore = new Map();
jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(async (path) => mockBaoStore.get(path) || null),
  set: jest.fn(async (path, value) => { mockBaoStore.set(path, value); })
}));

describe('proxy_client', () => {
  let proxyClient;
  let originalFetch;
  let mockFetchImpl;
  let calls;

  beforeEach(() => {
    jest.resetModules();
    mockBaoStore = new Map();
    calls = [];
    mockFetchImpl = async () => ({ ok: true, status: 404 });
    originalFetch = global.fetch;
    global.fetch = (...args) => { calls.push(args); return mockFetchImpl(...args); };
    proxyClient = require('../utils/proxy_client');
    proxyClient._reset();
    delete process.env.PROXY_INTERNAL_URL;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('skips cleanly when required fields are missing', async () => {
    const result = await proxyClient.ensureRelayRoute({ host: '', ip: '', targetPort: 0 });
    expect(result.note).toMatch(/required/);
    expect(calls.length).toBe(0);
  });

  test('skips cleanly when PROXY_INTERNAL_URL is not configured', async () => {
    const result = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result.note).toMatch(/PROXY_INTERNAL_URL/);
    expect(calls.length).toBe(0);
  });

  test('skips cleanly when no token is stored in OpenBao', async () => {
    process.env.PROXY_INTERNAL_URL = 'https://proxy.internal';
    const result = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result.note).toMatch(/no proxy API token/);
    expect(calls.length).toBe(0);
  });

  test('creates the route when the host does not already exist', async () => {
    process.env.PROXY_INTERNAL_URL = 'https://proxy.internal';
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_test_token' });
    mockFetchImpl = async (url, opts) => {
      if (opts.method === undefined) return { ok: true, status: 404 }; // GET lookup
      if (opts.method === 'POST') return { ok: true, status: 200 };
      throw new Error('unexpected method ' + opts.method);
    };

    const result = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result.note).toBe('created');

    const postCall = calls.find((c) => c[1].method === 'POST');
    expect(postCall[0]).toBe('https://proxy.internal/api/host');
    expect(postCall[1].headers.Authorization).toBe('Bearer prx_test_token');
    expect(JSON.parse(postCall[1].body)).toEqual({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
  });

  test('updates the route when it exists but points somewhere else', async () => {
    process.env.PROXY_INTERNAL_URL = 'https://proxy.internal';
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_test_token' });
    mockFetchImpl = async (url, opts) => {
      if (!opts.method) return { ok: true, status: 200, json: async () => ({ results: { ip: '172.24.9.9', targetPort: 3001 } }) };
      if (opts.method === 'PUT') return { ok: true, status: 200 };
      throw new Error('unexpected method ' + opts.method);
    };

    const result = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result.note).toBe('updated');
  });

  test('is a no-op when the route already matches', async () => {
    process.env.PROXY_INTERNAL_URL = 'https://proxy.internal';
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_test_token' });
    mockFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ results: { ip: '172.24.5.1', targetPort: 3001 } }) });

    const result = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result.note).toBe('already up to date');
  });

  test('reports a network failure without throwing', async () => {
    process.env.PROXY_INTERNAL_URL = 'https://proxy.internal';
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_test_token' });
    mockFetchImpl = async () => { throw new Error('connection refused'); };

    const result = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result.note).toMatch(/failed: connection refused/);
  });

  test('refreshes a stale cached token from OpenBao', async () => {
    jest.useFakeTimers();
    process.env.PROXY_INTERNAL_URL = 'https://proxy.internal';
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_initial' });
    mockFetchImpl = async () => ({ ok: true, status: 404 });

    await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(calls[0][1].headers.Authorization).toBe('Bearer prx_initial');

    // Replace the token in OpenBao and advance time past the cache max age.
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_rotated' });
    jest.advanceTimersByTime(6 * 60 * 1000);

    await proxyClient.ensureRelayRoute({ host: 'sso-b.example.com', ip: '172.24.5.2', targetPort: 3001 });
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1].headers.Authorization).toBe('Bearer prx_rotated');
    jest.useRealTimers();
  });

  test('invalidates the token cache on HTTP 401', async () => {
    process.env.PROXY_INTERNAL_URL = 'https://proxy.internal';
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_revoked' });
    mockFetchImpl = async (url, opts) => {
      if (!opts.method) return { ok: true, status: 404 };
      if (opts.method === 'POST') return { ok: false, status: 401 };
      throw new Error('unexpected method ' + opts.method);
    };

    const result = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result.note).toMatch(/HTTP 401/);

    // A subsequent call with a fresh token stored in OpenBao must use it,
    // proving the 401 path cleared the cache.
    mockBaoStore.set('integrations/theta-proxy', { token: 'prx_fresh' });
    mockFetchImpl = async (url, opts) => {
      if (!opts.method) return { ok: true, status: 404 };
      if (opts.method === 'POST') return { ok: true, status: 200 };
      throw new Error('unexpected method ' + opts.method);
    };
    const result2 = await proxyClient.ensureRelayRoute({ host: 'sso-a.example.com', ip: '172.24.5.1', targetPort: 3001 });
    expect(result2.note).toBe('created');
    const postCalls = calls.filter((c) => c[1].method === 'POST');
    expect(postCalls[postCalls.length - 1][1].headers.Authorization).toBe('Bearer prx_fresh');
  });
});
