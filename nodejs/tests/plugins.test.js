'use strict';

// Tests for the plugin system:
//   - plugin_registry: pure type discovery + configSchema helpers (no ORM, no
//     OpenBao, no LDAP) — the registry just requires the plugins/discovery/*.js
//     modules, which are real deps (node-fetch, node-nmap).
//   - plugin_secrets: OpenBao read/write/mergeForRun, with @simpleworkjs/bao-conf
//     mocked so no live OpenBao is needed.
//   - PluginInstance model: ORM round-trip against the same sqlite store the
//     rest of the suite uses (initORM), incl. the unique-slug constraint and
//     listEnabled. Like resource_site_slug.test.js, this is direct model use
//     rather than the LDAP-gated HTTP routes.

jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
  request: jest.fn(),
}));

const registry = require('../services/plugin_registry');
const pluginSecrets = require('../utils/plugin_secrets');
const baoConf = require('@simpleworkjs/bao-conf');
const { PluginInstance } = require('../models/plugin_instance');

describe('plugin_registry', () => {
  test('getTypes lists the built-in discovery plugins', () => {
    const types = registry.getTypes();
    const byType = Object.fromEntries(types.map(t => [t.type, t]));
    expect(byType.proxmox).toBeDefined();
    expect(byType.unifi).toBeDefined();
    expect(byType.nmap).toBeDefined();
    expect(byType.proxmox.category).toBe('discovery');
    expect(byType.proxmox.configSchema.length).toBeGreaterThan(0);
  });

  test('configSchema marks secret fields', () => {
    const m = registry.getManifest('proxmox');
    const secret = m.configSchema.find(f => f.key === 'tokenSecret');
    expect(secret.secret).toBe(true);
    expect(secret.required).toBe(true);
    expect(m.configSchema.find(f => f.key === 'url').secret).toBeFalsy();
  });

  test('requiredKeys / secretKeys / publicKeys split correctly', () => {
    expect(registry.requiredKeys('proxmox').sort()).toEqual(['tokenId', 'tokenSecret', 'url']);
    expect(registry.secretKeys('proxmox')).toEqual(['tokenSecret']);
    expect(registry.secretKeys('unifi')).toEqual(['password']);
    expect(registry.secretKeys('nmap')).toEqual([]);
    expect(registry.publicKeys('nmap').sort()).toEqual(['autoPromote', 'location', 'targetRange']);
  });

  test('splitConfig separates secret from non-secret and drops undeclared keys', () => {
    const { config, secrets } = registry.splitConfig('proxmox', {
      url: 'https://pve:8006',
      tokenId: 'u@pam!t',
      tokenSecret: 'shh',
      enabled: true, // not in configSchema -> dropped
      cron: '0 * * * *' // not in configSchema -> dropped
    });
    expect(config).toEqual({ url: 'https://pve:8006', tokenId: 'u@pam!t' });
    expect(secrets).toEqual({ tokenSecret: 'shh' });
  });

  test('mask redacts only secret values', () => {
    const masked = registry.mask('proxmox', { url: 'https://pve:8006', tokenId: 'u@pam!t', tokenSecret: 'shh' });
    expect(masked.url).toBe('https://pve:8006');
    expect(masked.tokenId).toBe('u@pam!t');
    expect(masked.tokenSecret).toBe('********');
  });

  test('getModule throws for an unknown type', () => {
    expect(() => registry.getModule('does-not-exist')).toThrow(/Unknown plugin type/);
  });

  test('getModule returns a module with run()/discover()', () => {
    const mod = registry.getModule('proxmox');
    expect(typeof mod.run).toBe('function');
    expect(typeof mod.discover).toBe('function');
    expect(typeof mod.validate).toBe('function');
  });
});

describe('plugin_secrets', () => {
  const VALID_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => { baoConf.get.mockReset(); baoConf.set.mockReset(); baoConf.request.mockReset(); });

  test('read returns the data object', async () => {
    baoConf.get.mockResolvedValue({ tokenSecret: 'shh' });
    const out = await pluginSecrets.read(VALID_ID);
    expect(out).toEqual({ tokenSecret: 'shh' });
    expect(baoConf.get).toHaveBeenCalledWith(`plugins/${VALID_ID}/conf`);
  });

  test('read returns {} when none stored', async () => {
    baoConf.get.mockResolvedValue(null);
    expect(await pluginSecrets.read(VALID_ID)).toEqual({});
  });

  test('write drops blank and masked placeholder values', async () => {
    await pluginSecrets.write(VALID_ID, { tokenSecret: 'new', keep: '********', blank: '' });
    expect(baoConf.set).toHaveBeenCalledWith(`plugins/${VALID_ID}/conf`, { tokenSecret: 'new' });
  });

  test('mergeForRun layers secrets over the row config', async () => {
    baoConf.get.mockResolvedValue({ tokenSecret: 'shh' });
    const instance = { id: VALID_ID, config: { url: 'https://pve:8006', tokenId: 'u@pam!t' } };
    const cfg = await pluginSecrets.mergeForRun(instance);
    expect(cfg).toEqual({ url: 'https://pve:8006', tokenId: 'u@pam!t', tokenSecret: 'shh' });
  });

  test('read rejects a non-uuid id', async () => {
    await expect(pluginSecrets.read('not-a-uuid')).rejects.toThrow(/invalid plugin instance id/);
  });

  test('remove is best-effort (404 is fine)', async () => {
    baoConf.request.mockResolvedValue({ status: 404 });
    await expect(pluginSecrets.remove(VALID_ID)).resolves.toBeUndefined();
  });
});

describe('PluginInstance model', () => {
  const marker = 'test_plugin_' + Date.now();
  const created = [];

  async function makeInstance(slug, extra = {}) {
    const r = await PluginInstance.create({
      pluginType: 'proxmox',
      category: 'discovery',
      name: 'Test ' + slug,
      slug: `${marker}_${slug}`,
      enabled: true,
      cron: '0 * * * *',
      config: { url: 'https://pve:8006' },
      ...extra
    });
    created.push(r);
    return r;
  }

  beforeAll(async () => {
    const { initORM } = require('../models');
    await initORM();
  });

  afterAll(async () => {
    for (const r of created) {
      try { await r.delete(); } catch (_) {}
    }
  });

  test('create generates a uuid id and round-trips json config', async () => {
    const r = await makeInstance('a');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/i);
    const fetched = await PluginInstance.get(r.id);
    expect(fetched.slug).toBe(`${marker}_a`);
    expect(fetched.config).toEqual({ url: 'https://pve:8006' });
  });

  test('slug is unique', async () => {
    await makeInstance('dup');
    await expect(makeInstance('dup')).rejects.toThrow(/Validation error|SequelizeUniqueConstraint/i);
  });

  test('getBySlug resolves', async () => {
    const r = await makeInstance('bySlug');
    const found = await PluginInstance.getBySlug(`${marker}_bySlug`);
    expect(found.id).toBe(r.id);
  });

  test('listEnabled returns only enabled instances', async () => {
    const on = await makeInstance('on', { enabled: true });
    const off = await makeInstance('off', { enabled: false });
    const enabled = await PluginInstance.listEnabled();
    const slugs = enabled.map(e => e.slug);
    expect(slugs).toContain(on.slug);
    expect(slugs).not.toContain(off.slug);
  });
});