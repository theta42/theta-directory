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
    SiteSpoke._seed([
      { endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' },
      { endpoint: 'https://spoke-b.example.com', pushToken: 'token-b' }
    ]);

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(mockFetchCalls.length).toBe(2);
    const urls = mockFetchCalls.map((c) => c[0]).sort();
    expect(urls).toEqual(['https://spoke-a.example.com/api/site/resync', 'https://spoke-b.example.com/api/site/resync']);

    const [, optsA] = mockFetchCalls.find((c) => c[0].includes('spoke-a'));
    expect(optsA.headers.Authorization).toBe('Bearer token-a');
    expect(JSON.parse(optsA.body).reason).toBe('catalog-changed');
  });

  // The mesh path now addresses the peer site's DIRECTORY directly
  // (10.<siteId>.0.2:3001). The gateway is a real router, so there is no
  // relay port and no local-gateway hop to derive (utils/mesh_route.js).
  test('prefers the peer directory over the mesh when the spoke reported a mesh IP', async () => {
    jest.resetModules();
    jest.doMock('../models/site_spoke', () => ({ SiteSpoke: makeSpokeMock() }));
    siteReplicate = require('../utils/site_replicate');
    SiteSpoke = require('../models/site_spoke').SiteSpoke;
    global.fetch = trackedFetch;

    SiteSpoke._seed([
      { endpoint: 'https://spoke-a.example.com:8443', pushToken: 'token-a', meshIp: '172.24.0.5' }
    ]);

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0][0]).toBe('http://10.5.0.2:3001/api/site/resync');
    // The gateway address identifies the site; it is never itself a service.
    expect(mockFetchCalls[0][0]).not.toContain('172.24.0.5');
  });

  test('falls back to the public endpoint if the mesh attempt fails', async () => {
    jest.resetModules();
    jest.doMock('../models/site_spoke', () => ({ SiteSpoke: makeSpokeMock() }));
    siteReplicate = require('../utils/site_replicate');
    SiteSpoke = require('../models/site_spoke').SiteSpoke;
    global.fetch = trackedFetch;

    SiteSpoke._seed([
      { endpoint: 'https://spoke-a.example.com', pushToken: 'token-a', meshIp: '172.24.0.5' }
    ]);
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

  // An address in the RETIRED scheme (site index in the third octet) is not a
  // mesh address any more. It must fall through to the public endpoint rather
  // than resolve to some other site's directory.
  test('an address in the retired scheme falls straight through to the endpoint', async () => {
    jest.resetModules();
    jest.doMock('../models/site_spoke', () => ({ SiteSpoke: makeSpokeMock() }));
    siteReplicate = require('../utils/site_replicate');
    SiteSpoke = require('../models/site_spoke').SiteSpoke;
    global.fetch = trackedFetch;

    SiteSpoke._seed([{ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a', meshIp: '172.24.5.1' }]);

    await siteReplicate.replicateToSpokes('catalog-changed');
    await new Promise((r) => setImmediate(r));

    expect(mockFetchCalls.length).toBe(1);
    expect(mockFetchCalls[0][0]).toBe('https://spoke-a.example.com/api/site/resync');
  });

  test('a spoke with no meshIp only ever tries the public endpoint', async () => {
    SiteSpoke._seed([{ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' }]);

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
    SiteSpoke._seed([
      { endpoint: 'https://dead-spoke.example.com', pushToken: 'token-dead' },
      { endpoint: 'https://live-spoke.example.com', pushToken: 'token-live' }
    ]);
    mockFetchImpl = async (url) => {
      if (url.includes('dead-spoke')) throw new Error('connection refused');
      return { ok: true, status: 200 };
    };

    await expect(siteReplicate.replicateToSpokes('event')).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r));
    expect(mockFetchCalls.length).toBe(2);
  });

  test('a non-2xx response from a spoke does not throw out of replicateToSpokes', async () => {
    SiteSpoke._seed([{ endpoint: 'https://spoke-a.example.com', pushToken: 'token-a' }]);
    mockFetchImpl = async () => ({ ok: false, status: 500 });
    await expect(siteReplicate.replicateToSpokes('event')).resolves.toBeUndefined();
  });

  test('SiteSpoke.list() throwing does not propagate to the caller', async () => {
    SiteSpoke.list = jest.fn(async () => { throw new Error('db unavailable'); });
    await expect(siteReplicate.replicateToSpokes('event')).resolves.toBeUndefined();
    expect(mockFetchCalls.length).toBe(0);
  });
});
