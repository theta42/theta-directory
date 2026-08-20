'use strict';

const spokeWriteProxy = require('../middleware/spoke_write_proxy');
const siteConfig = require('../utils/site_config');

// Requests are built the way EXPRESS builds them for a middleware mounted at
// '/api': req.path is MOUNT-RELATIVE ('/site/resync'), req.originalUrl is not
// ('/api/site/resync'). The previous test suite passed the absolute path as
// req.path, which is not a shape Express ever produces -- and that is exactly
// why it went green while every exemption in the middleware was dead.
function makeReq({ method = 'POST', url, headers = {}, body = {}, user }) {
  const [pathname] = url.split('?');
  const mountRelative = pathname.replace(/^\/api/, '') || '/';
  return {
    method,
    originalUrl: url,
    url: mountRelative,
    path: mountRelative,
    headers,
    body,
    user,
    ip: '192.168.1.100',
    protocol: 'https'
  };
}

function makeRes() {
  const res = {
    statusCode: null, body: null, headers: {}, jsonBody: null,
    status(s) { this.statusCode = s; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.body = b; return this; },
    json(j) { this.jsonBody = j; return this; }
  };
  return res;
}

const SPOKE = {
  isMaster: false,
  masterUrl: 'https://master.example.com',
  masterJoinKey: 'stj_test_join_key',
  replicationPushToken: 'push_test_token',
  siteSlug: 'site-branch'
};

describe('spoke_write_proxy middleware', () => {
  let originalFetch;
  let mockFetchCalls;
  let mockFetchImpl;

  beforeEach(() => {
    mockFetchCalls = [];
    mockFetchImpl = async () => ({
      status: 200,
      ok: true,
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
    jest.restoreAllMocks();
  });

  test('passes through immediately when node is Master', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({ isMaster: true });
    const next = jest.fn();
    await spokeWriteProxy(makeReq({ url: '/api/user' }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockFetchCalls.length).toBe(0);
  });

  test('passes through GET/HEAD/OPTIONS read requests on Spoke', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const next = jest.fn();
      await spokeWriteProxy(makeReq({ method, url: '/api/directory-admin/resources' }), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    }
    expect(mockFetchCalls.length).toBe(0);
  });

  // The regression this whole file exists for. Each of these was silently
  // forwarded to the master, which broke live replication, the WireGuard
  // roster, promotion, and SSSD auth respectively.
  test.each([
    ['POST', '/api/site/resync', 'the master\'s own replication ping'],
    ['POST', '/api/site/reregister', 'spoke re-registration'],
    ['POST', '/api/site/master-changed', 'promotion re-point'],
    ['POST', '/api/site/join', 'initial join'],
    ['PUT', '/api/mesh/self', 'the local gateway publishing its WireGuard key'],
    ['POST', '/api/mesh/clients', 'device enrolment at this site'],
    ['POST', '/api/directory-admin/site-promote', 'promoting THIS node'],
    ['POST', '/api/v1/ldap/bind', 'SSSD authentication'],
    ['POST', '/api/v1/ldap/search', 'SSSD user/group resolution'],
    ['POST', '/api/v1/agent/secrets', 'node-scoped agent secrets'],
    ['POST', '/api/agent/nodes/abc-123/command', 'a command needing this node\'s live WebSocket'],
    ['POST', '/api/auth/login', 'logging in to this site'],
    ['PUT', '/api/vault/users/alice/thing', 'a user secret in this site\'s OpenBao'],
    ['POST', '/api/oauth/client', 'this site\'s own OAuth client'],
    ['POST', '/api/webhook/abc', 'an inbound webhook authenticated by its own payload'],
    ['POST', '/api/discovery/run', 'a discovery plugin run, which is per-site'],
    ['POST', '/api/access-requests', 'a request row that is not replicated back'],
    ['POST', '/api/agent/join-keys', 'a join key that has to be redeemable here']
  ])('%s %s stays local (%s)', async (method, url) => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    const next = jest.fn();
    await spokeWriteProxy(makeReq({ method, url }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockFetchCalls.length).toBe(0);
  });

  test.each([
    ['POST', '/api/user'],
    ['PUT', '/api/user/alice'],
    ['POST', '/api/group'],
    ['DELETE', '/api/group/devs'],
    ['POST', '/api/directory-admin/resources'],
    ['POST', '/api/agent/enroll'],
    ['PUT', '/api/agent/nodes/abc-123'],
    ['POST', '/api/tos/accept'],
    ['POST', '/api/ldif-import']
  ])('%s %s forwards to the master', async (method, url) => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    const next = jest.fn();
    await spokeWriteProxy(
      makeReq({ method, url, user: { uid: 'alice' } }), makeRes(), next
    );
    expect(next).not.toHaveBeenCalled();
    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0].url).toBe('https://master.example.com' + url);
  });

  test('forwards with the spoke push token and user context, never the join key', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);

    const req = makeReq({
      url: '/api/directory-admin/resources',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: { name: 'New Host', kind: 'host', slug: 'host_new' },
      user: { uid: 'alice' }
    });
    const res = makeRes();
    const next = jest.fn();

    await spokeWriteProxy(req, res, next);

    expect(next).not.toHaveBeenCalled();
    const call = mockFetchCalls[0];
    expect(call.url).toBe('https://master.example.com/api/directory-admin/resources');
    expect(call.opts.method).toBe('POST');
    // The join key must never authenticate a forwarded write: it is a
    // cluster-wide operator credential, and pairing it with X-Forwarded-User
    // made it an impersonation token for any account.
    expect(call.opts.headers['authorization']).toBe('Bearer push_test_token');
    expect(call.opts.headers['authorization']).not.toContain('stj_');
    expect(call.opts.headers['x-forwarded-user']).toBe('alice');
    expect(call.opts.headers['x-forwarded-spoke']).toBe('site-branch');
    expect(JSON.parse(call.opts.body)).toEqual({ name: 'New Host', kind: 'host', slug: 'host_new' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body.toString())).toEqual({ status: 'ok', proxied: true });
  });

  test('does not leak the caller\'s own credentials upstream', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    const req = makeReq({
      url: '/api/user/alice',
      method: 'PUT',
      headers: { 'auth-token': 'local-session-uuid', cookie: 'sid=abc', 'content-type': 'application/json' },
      user: { uid: 'alice' }
    });
    await spokeWriteProxy(req, makeRes(), jest.fn());
    const sent = mockFetchCalls[0].opts.headers;
    expect(sent['auth-token']).toBeUndefined();
    expect(sent['cookie']).toBeUndefined();
    expect(sent['host']).toBeUndefined();
  });

  test('resolves the caller from an auth-token header when req.user is unset', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    const { Auth } = require('../models/auth');
    jest.spyOn(Auth, 'checkToken').mockResolvedValue({ uid: 'bob' });

    const req = makeReq({ url: '/api/user/accept-tos', headers: { 'auth-token': 'token-123' } });
    const res = makeRes();
    await spokeWriteProxy(req, res, jest.fn());

    expect(mockFetchCalls[0].opts.headers['x-forwarded-user']).toBe('bob');
    expect(res.statusCode).toBe(200);
  });

  test('hands an unresolvable caller to the local router rather than inventing an identity', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    const next = jest.fn();
    await spokeWriteProxy(makeReq({ url: '/api/user' , headers: {} }), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(mockFetchCalls.length).toBe(0);
  });

  test('synchronously updates local UserVerification and clears User cache on accept-tos success', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    const { Auth } = require('../models/auth');
    jest.spyOn(Auth, 'checkToken').mockResolvedValue({ uid: 'alice' });

    const { UserVerification } = require('../models/verification');
    const markTosAcceptedSpy = jest.fn().mockResolvedValue(true);
    jest.spyOn(UserVerification, 'getOrCreate').mockResolvedValue({ markTosAccepted: markTosAcceptedSpy });

    const { User } = require('../models/user');
    const clearCacheSpy = jest.spyOn(User, 'clearCache').mockImplementation(() => {});

    const res = makeRes();
    await spokeWriteProxy(
      makeReq({ url: '/api/user/accept-tos', headers: { 'auth-token': 'token-456' } }), res, jest.fn()
    );

    expect(res.statusCode).toBe(200);
    expect(UserVerification.getOrCreate).toHaveBeenCalledWith('alice');
    expect(markTosAcceptedSpy).toHaveBeenCalled();
    expect(clearCacheSpy).toHaveBeenCalled();
  });

  test('applies a forwarded DOB update locally so onboarding can proceed immediately', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);

    const { User } = require('../models/user');
    const clearCacheSpy = jest.spyOn(User, 'clearCache').mockImplementation(() => {});
    const updateSpy = jest.fn().mockResolvedValue({});
    jest.spyOn(User, 'get').mockResolvedValue({ update: updateSpy });

    const res = makeRes();
    await spokeWriteProxy(
      makeReq({
        method: 'PUT',
        url: '/api/user/alice',
        user: { uid: 'alice' },
        body: { dateOfBirth: '1990-06-15' }
      }),
      res,
      jest.fn()
    );

    expect(res.statusCode).toBe(200);
    expect(User.get).toHaveBeenCalledWith('alice');
    expect(updateSpy).toHaveBeenCalledWith({ dateOfBirth: '1990-06-15' });
    expect(clearCacheSpy).toHaveBeenCalled();
  });

  test('returns 503 when Master is unreachable', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue(SPOKE);
    mockFetchImpl = async () => { throw new Error('Connection refused'); };

    const res = makeRes();
    const next = jest.fn();
    await spokeWriteProxy(makeReq({ url: '/api/user', user: { uid: 'bob' }, body: { uid: 'bob' } }), res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.message).toContain('unreachable for write operations');
  });

  test('returns 503 with a recovery hint when this spoke has no push token', async () => {
    jest.spyOn(siteConfig, 'get').mockReturnValue({ ...SPOKE, replicationPushToken: undefined });
    const res = makeRes();
    await spokeWriteProxy(makeReq({ url: '/api/user', user: { uid: 'bob' } }), res, jest.fn());
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.message).toContain('Re-register');
    expect(mockFetchCalls.length).toBe(0);
  });
});
