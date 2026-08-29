'use strict';

// The contract every discovery plugin has to hold to.
//
// These are the invariants that were broken in four of the five plugins, in
// ways nothing detected: a made-up `kind` the system does not understand, and a
// missing `subType`, which is not neutral because an empty subType falls in the
// ssh-capable bucket and turns printers and phones into jump targets.

const fs = require('fs');
const path = require('path');
const registry = require('../services/plugin_registry');
const { templateFor, _setTemplateCache } = require('../services/subtype_templates');
const { SubtypeTemplate } = require('../models/subtype_template');
const { validateDiscoveryPayload, withTimeout } = require('../services/scheduler');

const CANONICAL_KINDS = new Set(['site', 'host', 'service', 'oauth']);
const discoveryDir = path.join(__dirname, '..', 'plugins', 'discovery');
const pluginFiles = fs.readdirSync(discoveryDir).filter(f => f.endsWith('.js'));
const knownSubtypes = new Set(SubtypeTemplate.defaults().map(t => t.slug));

describe('every discovery plugin declares a usable manifest', () => {
  for (const file of pluginFiles) {
    const type = path.basename(file, '.js');
    test(`${type} has the fields the registry and UI need`, () => {
      const manifest = registry.getManifest(type);
      expect(manifest).toBeTruthy();
      expect(manifest.category).toBe('discovery');
      expect(typeof manifest.run).toBe('function');
      expect(Array.isArray(manifest.configSchema)).toBe(true);
      for (const field of manifest.configSchema) {
        expect(typeof field.key).toBe('string');
        expect(field.key.length).toBeGreaterThan(0);
        expect(typeof field.label).toBe('string');
      }
    });
  }
});

describe('kind is a closed, structural vocabulary', () => {
  // `kind` says where a thing sits in the graph. WHAT it is belongs in
  // metadata.subType, where the vocabulary and its capability flags live.
  for (const file of pluginFiles) {
    test(`${file} emits only canonical kinds`, () => {
      const src = fs.readFileSync(path.join(discoveryDir, file), 'utf8');
      const kinds = [...src.matchAll(/^\s*kind:\s*'([a-z_]+)'/gm)].map(m => m[1]);
      const bad = [...new Set(kinds)].filter(k => !CANONICAL_KINDS.has(k));
      expect(bad).toEqual([]);
    });
  }

  test('the payload validator rejects a non-canonical kind rather than storing it', () => {
    const out = validateDiscoveryPayload({
      resources: [{ slug: 'a', kind: 'network_device' }, { slug: 'b', kind: 'host' }],
      edges: []
    });
    expect(out.ok).toBe(true);
    expect(out.payload.resources.map(r => r.slug)).toEqual(['b']);
    expect(out.dropped.join(' ')).toMatch(/unknown kind 'network_device'/);
  });
});

describe('classification fails closed across every classifier', () => {
  afterEach(() => _setTemplateCache(null));

  const withRealTemplates = () => _setTemplateCache(Object.fromEntries(
    SubtypeTemplate.defaults().map(t => [t.slug, {
      identityClass: t.identity_class || t.target_kind,
      sshCapable: Boolean(t.ssh_capable),
      inheritsHost: Boolean(t.inherits_host_access)
    }])));

  test('nmap: an unclassifiable host is not ssh-capable', () => {
    const nmap = require('../plugins/discovery/nmap');
    withRealTemplates();
    const subType = nmap.classifyHost({});
    expect(knownSubtypes.has(subType)).toBe(true);
    expect(templateFor({ kind: 'host', metadata: { subType } }).sshCapable).toBe(false);
  });

  test('unifi: switches and APs are classified, and never ssh-capable', () => {
    const unifi = require('../plugins/discovery/unifi');
    withRealTemplates();
    expect(unifi.classifyDevice({ type: 'usw', model: 'US-24' })).toBe('unifi_switch');
    expect(unifi.classifyDevice({ type: 'uap', model: 'U6-Pro' })).toBe('unifi_ap');
    expect(unifi.classifyDevice({ type: 'udm', model: 'UDM-Pro' })).toBe('router');
    expect(unifi.classifyDevice({})).toBe('unknown');

    for (const dev of [{ type: 'usw' }, { type: 'uap' }, { type: 'udm' }, {}]) {
      const subType = unifi.classifyDevice(dev);
      expect(knownSubtypes.has(subType)).toBe(true);
      expect(templateFor({ kind: 'host', metadata: { subType } }).sshCapable).toBe(false);
    }
  });

  test('every subtype any classifier can return exists in the vocabulary', () => {
    const nmap = require('../plugins/discovery/nmap');
    const unifi = require('../plugins/discovery/unifi');
    const produced = new Set([
      nmap.classifyHost({ osNmap: 'Linux 5.4' }),
      nmap.classifyHost({ osNmap: 'Microsoft Windows' }),
      nmap.classifyHost({}),
      unifi.classifyDevice({ type: 'usw' }),
      unifi.classifyDevice({ type: 'uap' }),
      unifi.classifyDevice({ type: 'ugw' }),
      unifi.classifyDevice({}),
      'unknown-service'
    ]);
    expect([...produced].filter(s => !knownSubtypes.has(s))).toEqual([]);
  });
});

describe('a plugin run cannot hang the queue', () => {
  test('withTimeout rejects a promise that never settles', async () => {
    await expect(withTimeout(new Promise(() => {}), 30, 'stuck plugin'))
      .rejects.toThrow(/stuck plugin timed out/);
  });

  test('withTimeout passes a value straight through', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000, 'x')).resolves.toBe('done');
  });

  test('withTimeout does not mask a real rejection', async () => {
    await expect(withTimeout(Promise.reject(new Error('auth failed')), 1000, 'x'))
      .rejects.toThrow('auth failed');
  });
});

describe('the reconciler is never handed a payload it cannot use', () => {
  test('a plugin returning nothing is a run failure, not a graph write', () => {
    expect(validateDiscoveryPayload(undefined).ok).toBe(false);
    expect(validateDiscoveryPayload(null).ok).toBe(false);
    expect(validateDiscoveryPayload({ resources: 'nope' }).ok).toBe(false);
    expect(validateDiscoveryPayload({ resources: [], edges: 'nope' }).ok).toBe(false);
  });

  test('individually broken rows are dropped, not the whole run', () => {
    const out = validateDiscoveryPayload({
      resources: [
        { slug: 'good', kind: 'host' },
        { noSlug: true },
        { slug: 'good' },                        // duplicate
        { slug: 'meta-bad', metadata: 'string' }
      ],
      edges: [
        { parentSlug: 'good', childSlug: 'other' },
        { parentSlug: 'x' },                     // no child
        { parentSlug: 'good', childSlug: 'good' } // self-edge
      ]
    });
    expect(out.ok).toBe(true);
    expect(out.payload.resources.map(r => r.slug)).toEqual(['good']);
    expect(out.payload.edges).toHaveLength(1);
    expect(out.dropped).toHaveLength(5);
  });

  test('a payload with no edges key is fine', () => {
    const out = validateDiscoveryPayload({ resources: [{ slug: 'a', kind: 'host' }] });
    expect(out.ok).toBe(true);
    expect(out.payload.edges).toEqual([]);
  });
});
