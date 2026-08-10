'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Point SITE_CONFIG_FILE at a fresh temp path and clear the env defaults so
// each test observes a known state. jest.resetModules() gives a fresh module
// (the `current` cache is module-scoped).
function freshEnv(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-cfg-'));
  const file = path.join(dir, 'site.json');
  for (const k of ['IS_MASTER', 'MASTER_URL', 'SITE_SLUG', 'SITE_CONFIG_FILE']) delete process.env[k];
  process.env.SITE_CONFIG_FILE = file;
  Object.assign(process.env, overrides);
  jest.resetModules();
  return { file };
}

test('site_config defaults to a fresh master / site-default with no file', () => {
  freshEnv();
  const sc = require('../utils/site_config');
  const c = sc.get();
  expect(c.isMaster).toBe(true);
  expect(c.masterUrl).toBe('');
  expect(c.siteSlug).toBe('site-default');
  expect(c.wanConnected).toBe(true);
});

test('site_config honors the env seed values', () => {
  freshEnv({ IS_MASTER: 'false', MASTER_URL: 'https://m.example.com', SITE_SLUG: 'site-east' });
  const sc = require('../utils/site_config');
  const c = sc.get();
  expect(c.isMaster).toBe(false);
  expect(c.masterUrl).toBe('https://m.example.com');
  expect(c.siteSlug).toBe('site-east');
});

test('site_config save persists and a fresh require reloads it', () => {
  const { file } = freshEnv();
  const sc = require('../utils/site_config');
  sc.save({ isMaster: false, masterUrl: 'https://m.example.com', siteSlug: 'site-east' });

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  expect(onDisk.isMaster).toBe(false);
  expect(onDisk.siteSlug).toBe('site-east');

  jest.resetModules();
  const sc2 = require('../utils/site_config');
  const c = sc2.get();
  expect(c.isMaster).toBe(false);
  expect(c.masterUrl).toBe('https://m.example.com');
  expect(c.siteSlug).toBe('site-east');
});

test('site_config save returns the merged config', () => {
  freshEnv();
  const sc = require('../utils/site_config');
  const c = sc.save({ masterUrl: 'https://m.example.com' });
  expect(c.isMaster).toBe(true); // untouched default survives
  expect(c.masterUrl).toBe('https://m.example.com');
});
