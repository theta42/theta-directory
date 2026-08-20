'use strict';

const { fetchWithAuthRedirect, MAX_REDIRECTS, REDIRECT_CODES } = require('../utils/fetch_with_auth_redirect');

describe('fetchWithAuthRedirect', () => {
  const originalFetch = global.fetch;
  let mockFetch;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeResponse({ status = 200, location } = {}) {
    const headers = new Map();
    if (location) headers.set('location', location);
    return {
      status,
      ok: status >= 200 && status < 300,
      headers: {
        get(name) { return headers.get(name.toLowerCase()) || null; },
        entries() { return headers.entries(); }
      }
    };
  }

  test('returns non-redirect response directly', async () => {
    const resp = makeResponse({ status: 200 });
    mockFetch.mockResolvedValue(resp);
    const result = await fetchWithAuthRedirect('https://example.com/api', { method: 'POST', headers: { Authorization: 'Bearer token' }, body: '{}' });
    expect(result).toBe(resp);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const call = mockFetch.mock.calls[0];
    expect(call[0]).toBe('https://example.com/api');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.Authorization).toBe('Bearer token');
    expect(call[1].body).toBe('{}');
  });

  test('follows same-host http -> https 301 preserving method, headers, and body', async () => {
    mockFetch.mockImplementation(async (url, init) => {
      if (url === 'http://example.com/api') {
        return makeResponse({ status: 301, location: 'https://example.com/api' });
      }
      if (url === 'https://example.com/api') {
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer token');
        expect(init.body).toBe('{}');
        return makeResponse({ status: 200 });
      }
      throw new Error('unexpected url: ' + url);
    });

    const result = await fetchWithAuthRedirect('http://example.com/api', { method: 'POST', headers: { Authorization: 'Bearer token' }, body: '{}' });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('follows same-host https -> https 307 preserving method, headers, and body', async () => {
    mockFetch.mockImplementation(async (url, init) => {
      if (url === 'https://example.com/api') {
        return makeResponse({ status: 307, location: 'https://example.com/api/retry' });
      }
      if (url === 'https://example.com/api/retry') {
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer token');
        expect(init.body).toBe('{}');
        return makeResponse({ status: 200 });
      }
      throw new Error('unexpected url: ' + url);
    });

    const result = await fetchWithAuthRedirect('https://example.com/api', { method: 'POST', headers: { Authorization: 'Bearer token' }, body: '{}' });
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('refuses cross-host redirect', async () => {
    mockFetch.mockResolvedValue(makeResponse({ status: 301, location: 'https://evil.example.com/api' }));
    await expect(fetchWithAuthRedirect('https://example.com/api', { method: 'POST', headers: { Authorization: 'Bearer token' }, body: '{}' }))
      .rejects.toThrow('refusing cross-host redirect from example.com to evil.example.com');
  });

  test('throws on redirect with no Location header', async () => {
    mockFetch.mockResolvedValue({ status: 301, headers: { get: () => null, entries: () => [].entries() } });
    await expect(fetchWithAuthRedirect('https://example.com/api', { method: 'POST' }))
      .rejects.toThrow('status 301 but no Location header');
  });

  test('gives up after too many redirects', async () => {
    mockFetch.mockResolvedValue(makeResponse({ status: 301, location: 'https://example.com/api/1' }));
    await expect(fetchWithAuthRedirect('https://example.com/api', { method: 'POST' }))
      .rejects.toThrow('too many redirects');
    expect(mockFetch).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
  });

  test('aborts on timeout', async () => {
    // Mock a fetch that observes the abort signal the way real fetch does.
    mockFetch.mockImplementation((url, init) => {
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(new Error('The operation was aborted'));
        if (init && init.signal && init.signal.aborted) {
          return onAbort();
        }
        if (init && init.signal) {
          init.signal.addEventListener('abort', onAbort);
        }
      });
    });
    const start = Date.now();
    await expect(fetchWithAuthRedirect('https://example.com/api', { method: 'POST' }, { timeoutMs: 50 }))
      .rejects.toThrow('aborted');
    expect(Date.now() - start).toBeLessThan(500);
  });
});
