'use strict';

const spokeWriteProxy = require('../middleware/spoke_write_proxy');
const siteConfig = require('../utils/site_config');

describe('spoke_write_proxy middleware', () => {
  let originalFetch;
  let mockFetchCalls;
  let mockFetchImpl;

  beforeEach(() => {
    mockFetchCalls = [];
    mockFetchImpl = async () => ({
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      arrayBuffer: async () => Buffer.from(JSON.stringify({ status: 'ok', proxied: true }))
    });

    originalFetch = global.fetch;
    global.fetch = async (url, opts) => {
      mockFetchCalls.push({ url, opts });
      return mockFetchImpl(url, opts);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('passes through immediately when node is Master', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({ isMaster: true });
    const req = { method: 'POST', path: '/api/user', originalUrl: '/api/user' };
    const res = {};
    const next = jest.fn();

    await spokeWriteProxy(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockFetchCalls.length).toBe(0);
  });

  test('passes through GET/HEAD/OPTIONS read requests on Spoke', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({ isMaster: false, masterUrl: 'https://master.example.com' });
    const res = {};

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const next = jest.fn();
      await spokeWriteProxy({ method, path: '/api/directory-admin/resources', originalUrl: '/api/directory-admin/resources' }, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(mockFetchCalls.length).toBe(0);
  });

  test('passes through exempt paths (auth, site lifecycle, promote)', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({ isMaster: false, masterUrl: 'https://master.example.com' });
    const res = {};

    const exempts = [
      { method: 'POST', path: '/api/auth/login', originalUrl: '/api/auth/login' },
      { method: 'POST', path: '/api/site/resync', originalUrl: '/api/site/resync' },
      { method: 'POST', path: '/api/site/join', originalUrl: '/api/site/join' },
      { method: 'POST', path: '/api/mesh/self', originalUrl: '/api/mesh/self' },
      { method: 'POST', path: '/api/directory-admin/site-promote', originalUrl: '/api/directory-admin/site-promote' }
    ];

    for (const req of exempts) {
      const next = jest.fn();
      await spokeWriteProxy(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(mockFetchCalls.length).toBe(0);
  });

  test('transparently forwards mutating request on Spoke to Master with user context', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({
      isMaster: false,
      masterUrl: 'https://master.example.com',
      masterJoinKey: 'stj_test_join_key',
      siteSlug: 'site-branch'
    });

    const req = {
      method: 'POST',
      path: '/api/directory-admin/resources',
      originalUrl: '/api/directory-admin/resources',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json'
      },
      user: { uid: 'alice' },
      body: { name: 'New Host', kind: 'host', slug: 'host_new' },
      ip: '192.168.1.100',
      protocol: 'https'
    };

    let sentStatus = null;
    let sentBody = null;
    const sentHeaders = {};
    const res = {
      status(s) { sentStatus = s; return this; },
      setHeader(k, v) { sentHeaders[k] = v; },
      send(b) { sentBody = b; }
    };
    const next = jest.fn();

    await spokeWriteProxy(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockFetchCalls.length).toBe(1);
    const call = mockFetchCalls[0];
    expect(call.url).toBe('https://master.example.com/api/directory-admin/resources');
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers['authorization']).toBe('Bearer stj_test_join_key');
    expect(call.opts.headers['x-forwarded-user']).toBe('alice');
    expect(call.opts.headers['x-forwarded-spoke']).toBe('site-branch');
    expect(JSON.parse(call.opts.body)).toEqual({ name: 'New Host', kind: 'host', slug: 'host_new' });

    expect(sentStatus).toBe(200);
    expect(JSON.parse(sentBody.toString())).toEqual({ status: 'ok', proxied: true });
  });

  test('resolves user from auth-token header when req.user is not yet populated', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({
      isMaster: false,
      masterUrl: 'https://master.example.com',
      masterJoinKey: 'stj_test_join_key',
      siteSlug: 'site-branch'
    });

    const { Auth } = require('../models/auth');
    jest.spyOn(Auth, 'checkToken').mockResolvedValue({ uid: 'bob' });

    const req = {
      method: 'POST',
      path: '/api/user/accept-tos',
      originalUrl: '/api/user/accept-tos',
      headers: {
        'auth-token': 'token-123'
      },
      body: {}
    };

    let sentStatus = null;
    let sentBody = null;
    const sentHeaders = {};
    const res = {
      status(s) { sentStatus = s; return this; },
      setHeader(k, v) { sentHeaders[k] = v; },
      send(b) { sentBody = b; }
    };
    const next = jest.fn();

    await spokeWriteProxy(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(mockFetchCalls.length).toBe(1);
    const call = mockFetchCalls[0];
    expect(call.url).toBe('https://master.example.com/api/user/accept-tos');
    expect(call.opts.method).toBe('POST');
    expect(call.opts.headers['authorization']).toBe('Bearer stj_test_join_key');
    expect(call.opts.headers['x-forwarded-user']).toBe('bob');
    expect(sentStatus).toBe(200);
  });

  test('returns 503 when Master is unreachable', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({
      isMaster: false,
      masterUrl: 'https://master.example.com',
      masterJoinKey: 'stj_test_join_key'
    });

    mockFetchImpl = async () => { throw new Error('Connection refused'); };

    const req = {
      method: 'POST',
      path: '/api/user',
      originalUrl: '/api/user',
      headers: {},
      body: { uid: 'bob' }
    };

    let sentStatus = null;
    let sentJson = null;
    const res = {
      status(s) { sentStatus = s; return this; },
      json(j) { sentJson = j; return this; }
    };
    const next = jest.fn();

    await spokeWriteProxy(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(sentStatus).toBe(503);
    expect(sentJson.status).toBe('error');
    expect(sentJson.message).toContain('unreachable for write operations');
  });
});
