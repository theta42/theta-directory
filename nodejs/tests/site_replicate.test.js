'use strict';

// In-memory stand-in for the SiteSpoke ORM model.
let spokeStore;
function makeSpokeMock() {
  spokeStore = [];
  return {
    list: jest.fn(async () => [...spokeStore]),
    _seed(rows) { spokeStore.push(...rows); }
  };
}

// The real SiteSpoke instances have an instance update() method. The previous
// mock used plain objects, so the production code path that updates
// last_seen_on on a successful resync was silently swallowed by the .catch()
// and never exercised. Give each mock spoke a spy update().
function spokeWithUpdate(spoke) {
  const updates = [];
  const withUpdate = {
    ...spoke,
    update: jest.fn(async (patch) => { updates.push(patch); Object.assign(withUpdate, patch); return withUpdate; }),
    _updates: updates
  };
  return withUpdate;
}

let mockFetchCalls = [];
let mockFetchImpl = async () => ({ ok: true, status: 200 });
// Shared so a test that re-requires the module (to pick up a different
// JUMP_INTERNAL_URL) can reinstall the same recorder.
const trackedFetch = (...args) => { mockFetchCalls.push(args); return mockFetchImpl(...args); };

describe('site_replicate', () => {
  let siteReplicate;
  let SiteSpoke;
  let originalFetch;

  beforeEach(() => {
    jest.resetModules();
    mockFetchCalls = [];
    mockFetchImpl = async () => ({ ok: true, status: 200 });

    jest.doMock('../models/site_spoke', () => ({ SiteSpoke: makeSpokeMock() }));
    siteReplicate = require('../utils/site_replicate');
    SiteSpoke = require('../models/site_spoke').SiteSpoke;

    // site_replicate.js uses the global fetch (Node 18+ built-in), not
    // node-fetch -- stub that directly.
    originalFetch = global.fetch;
    global.fetch = trackedFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.JUMP_INTERNAL_URL;
  });

  test('pushes to every known spoke concurrently with its own pushToken', async () => {
    const spokeA = spokeWithUpdate({ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' });
    const spokeB = spokeWithUpdate({ endpoint: 'https://spoke-b.example.com', pushToken: 'token-b' });
    SiteSpoke._seed([spokeA, spokeB]);

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(mockFetchCalls.length).toBe(2);
    const urls = mockFetchCalls.map((c) => c[0]).sort();
    expect(urls).toEqual(['https://spoke-a.example.com/api/site/resync', 'https://spoke-b.example.com/api/site/resync']);

    const [, optsA] = mockFetchCalls.find((c) => c[0].includes('spoke-a'));
    expect(optsA.headers.Authorization).toBe('Bearer token-a');
    expect(JSON.parse(optsA.body).reason).toBe('catalog-changed');

    // A successful push updates last_seen_on on the spoke record.
    expect(spokeA.update).toHaveBeenCalledWith(expect.objectContaining({ last_seen_on: expect.any(Number) }));
    expect(spokeB.update).toHaveBeenCalledWith(expect.objectContaining({ last_seen_on: expect.any(Number) }));
  });

  // The mesh path addresses the peer site's DIRECTORY directly
  // (10.<siteId>.0.2:3001). The gateway is a real router, so there is no
  // relay port and no local-gateway hop to derive (utils/mesh_route.js).
  // Every site is a mesh node, so a spoke with a ServerID is dialled over the
  // tunnel by default -- no meshIp field required.
  test('prefers the peer directory over the mesh for any spoke with a ServerID', async () => {
    jest.resetModules();
    jest.doMock('../models/site_spoke', () => ({ SiteSpoke: makeSpokeMock() }));
    siteReplicate = require('../utils/site_replicate');
    SiteSpoke = require('../models/site_spoke').SiteSpoke;
    global.fetch = trackedFetch;

    SiteSpoke._seed([
      spokeWithUpdate({ endpoint: 'https://spoke-a.example.com:8443', pushToken: 'token-a', ldapServerId: 5 })
    ]);

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0][0]).toBe('http://10.5.0.2:3001/api/site/resync');
  });

  test('falls back to the public endpoint if the mesh attempt fails', async () => {
    jest.resetModules();
    jest.doMock('../models/site_spoke', () => ({ SiteSpoke: makeSpokeMock() }));
    siteReplicate = require('../utils/site_replicate');
    SiteSpoke = require('../models/site_spoke').SiteSpoke;
    global.fetch = trackedFetch;

    const spokeA = spokeWithUpdate({ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a', ldapServerId: 5 });
    SiteSpoke._seed([spokeA]);
    // A deployment whose containers have no route for 10.0.0.0/8 via the
    // gateway must still replicate -- just over the internet, not the tunnel.
    mockFetchImpl = async (url) => {
      if (url.startsWith('http://10.')) throw new Error('mesh unreachable');
      return { ok: true, status: 200 };
    };

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(mockFetchCalls.length).toBe(2);
    expect(mockFetchCalls[0][0]).toBe('http://10.5.0.2:3001/api/site/resync');
    expect(mockFetchCalls[1][0]).toBe('https://spoke-a.example.com/api/site/resync');
  });

  test('a spoke with no ServerID yet only ever tries the public endpoint', async () => {
    SiteSpoke._seed([spokeWithUpdate({ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' })]);

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0][0]).toBe('https://spoke-a.example.com/api/site/resync');
  });

  test('no known spokes: resolves cleanly, no fetch calls', async () => {
    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));
    expect(mockFetchCalls.length).toBe(0);
  });

  test('one spoke failing does not prevent delivery to another', async () => {
    const live = spokeWithUpdate({ endpoint: 'https://live-spoke.example.com', pushToken: 'token-live' });
    SiteSpoke._seed([
      spokeWithUpdate({ endpoint: 'https://dead-spoke.example.com', pushToken: 'token-dead' }),
      live
    ]);
    mockFetchImpl = async (url) => {
      if (url.includes('dead-spoke')) throw new Error('connection refused');
      return { ok: true, status: 200 };
    };

    await expect(siteReplicate.replicateToSpokes('event')).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(mockFetchCalls.length).toBe(2);
    // Only the successful spoke gets last_seen_on updated.
    expect(live.update).toHaveBeenCalledWith(expect.objectContaining({ last_seen_on: expect.any(Number) }));
  });

  test('a non-2xx response from a spoke does not throw out of replicateToSpokes', async () => {
    SiteSpoke._seed([spokeWithUpdate({ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' })]);
    mockFetchImpl = async () => ({ ok: false, status: 500 });
    await expect(siteReplicate.replicateToSpokes('event')).resolves.toBeUndefined();
  });

  test('tries https first for an http registry endpoint and follows same-host 301 redirect preserving POST body and Authorization', async () => {
    const spokeA = spokeWithUpdate({ endpoint: 'http://spoke-a.example.com', pushToken: 'token-a' });
    SiteSpoke._seed([spokeA]);

    let redirected = false;
    mockFetchImpl = async (url, init) => {
      if (url === 'https://spoke-a.example.com/api/site/resync') {
        return {
          status: 301,
          ok: false,
          headers: new Map([['location', 'https://spoke-a.example.com/api/site/resync/retry']]),
          get(name) { return this.headers.get(name.toLowerCase()); }
        };
      }
      if (url === 'https://spoke-a.example.com/api/site/resync/retry') {
        redirected = true;
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer token-a');
        expect(JSON.parse(init.body).reason).toBe('catalog-changed');
        return { ok: true, status: 200 };
      }
      throw new Error('unexpected url: ' + url);
    };

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(redirected).toBe(true);
    expect(spokeA.update).toHaveBeenCalledWith(expect.objectContaining({ last_seen_on: expect.any(Number) }));
  });

  test('refuses cross-host redirects to avoid leaking the push token', async () => {
    SiteSpoke._seed([spokeWithUpdate({ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' })]);

    mockFetchImpl = async (url) => {
      if (url === 'https://spoke-a.example.com/api/site/resync') {
        return {
          status: 301,
          ok: false,
          headers: new Map([['location', 'https://evil.example.com/api/site/resync']]),
          get(name) { return this.headers.get(name.toLowerCase()); }
        };
      }
      return { ok: true, status: 200 };
    };

    await expect(siteReplicate.pushResync(spokeWithUpdate({ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' }), 'event'))
      .rejects.toThrow('cross-host redirect');
  });

  test('SiteSpoke.list() throwing does not propagate to the caller', async () => {
    SiteSpoke.list = jest.fn(async () => { throw new Error('db unavailable'); });
    await expect(siteReplicate.replicateToSpokes('event')).resolves.toBeUndefined();
    expect(mockFetchCalls.length).toBe(0);
  });
});
