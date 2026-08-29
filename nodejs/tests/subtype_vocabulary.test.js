'use strict';

// The shipped subtype vocabulary, and the capability flags the rest of the
// system reads off it.
//
// The point of these tests is that the templates and the code that consumes
// them cannot drift apart silently: every subType any plugin or the agent can
// emit must have a template, and the flags on those templates must agree with
// the bootstrap tables they replaced.

const { SubtypeTemplate } = require('../models/subtype_template');
const {
  templateFor, _setTemplateCache,
  SSH_CAPABLE_HOST_SUBTYPES, NEVER_SSH_SUBTYPES, AGENT_SERVICE_SUBTYPES
} = require('../services/subtype_templates');

const defaults = SubtypeTemplate.defaults();
const bySlug = new Map(defaults.map(t => [t.slug, t]));

afterEach(() => _setTemplateCache(null));

describe('the shipped vocabulary', () => {
  test('slugs are unique', () => {
    const slugs = defaults.map(t => t.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  test('every template names a valid target kind', () => {
    for (const t of defaults) {
      expect(['site', 'host', 'service']).toContain(t.target_kind);
    }
  });

  test('every subtype the design document names has a template', () => {
    const named = [
      // sites
      'suite', 'managed', 'wg-node', 'unmanaged',
      // hosts
      'router', 'switch', 'ap', 'desktop', 'laptop', 'server',
      'server-proxmox', 'proxmox-lxc', 'proxmox-kvm', 'server-hyperv', 'server-unraid',
      // services
      'systemd', 'windows-service', 'process', 'ssh', 'http', 'theta-agent', 'wireguard'
    ];
    expect(named.filter(s => !bySlug.has(s))).toEqual([]);
  });

  test('every subType a discovery plugin or the agent can emit has a template', () => {
    // Kept in step with plugins/discovery/*.js and utils/agent_manager.js.
    const emitted = [
      'proxmox', 'hypervisor', 'vm', 'lxc', 'template',  // proxmox
      'ilo',                                              // ilo
      'docker',                                           // docker
      'unknown', 'unknown-service',                       // nmap
      'linux', 'systemd'                                  // theta-agent
    ];
    expect(emitted.filter(s => !bySlug.has(s))).toEqual([]);
  });

  test('guest subtypes are confined to something that can host them', () => {
    for (const slug of ['lxc', 'vm', 'proxmox-lxc', 'proxmox-kvm']) {
      const t = bySlug.get(slug);
      expect(t.valid_parent_types).toEqual(['host']);
      expect(t.valid_parent_subtypes.length).toBeGreaterThan(0);
    }
  });

  test('sites are roots and services hang off hosts', () => {
    for (const t of defaults) {
      if (t.target_kind === 'site') expect(t.valid_parent_types).toEqual([]);
      // A service parents onto a host, and may additionally parent onto another
      // service: an OAuth client belongs to the service it authenticates for
      // (the Proxy's client hangs off the Proxy), which is one level below a
      // host. Nothing else may be a service's parent.
      if (t.target_kind === 'service') {
        expect(t.valid_parent_types).toContain('host');
        expect(t.valid_parent_types.filter(p => p !== 'host' && p !== 'service')).toEqual([]);
      }
    }
  });

  test('oauth clients are a service subtype, not a kind of their own', () => {
    for (const slug of ['oauth', 'oidc-client', 'saml-sp']) {
      const t = bySlug.get(slug);
      expect(t).toBeDefined();
      expect(t.target_kind).toBe('service');
      // No <slug>_access/_admin pair: an OAuth client's authorization is its
      // own allowed_groups, checked at token issue.
      expect(t.inherits_host_access).toBe(true);
      expect(t.valid_parent_types).toContain('service');
    }
    expect(defaults.filter(t => t.target_kind === 'oauth')).toEqual([]);
  });

  test('nothing that is not a shell is marked ssh_capable', () => {
    for (const slug of ['ilo', 'idrac', 'bmc', 'switch', 'ap', 'printer', 'camera', 'router', 'unknown', 'template']) {
      expect(bySlug.get(slug).ssh_capable).toBeFalsy();
    }
  });

  test('the capability flags agree with the bootstrap tables they replaced', () => {
    for (const slug of SSH_CAPABLE_HOST_SUBTYPES) {
      if (!slug || !bySlug.has(slug)) continue; // '' and debian/ubuntu have no template by design
      expect(bySlug.get(slug).ssh_capable).toBe(true);
    }
    for (const slug of NEVER_SSH_SUBTYPES) {
      if (!bySlug.has(slug)) continue;
      expect(bySlug.get(slug).ssh_capable).toBeFalsy();
    }
    for (const slug of AGENT_SERVICE_SUBTYPES) {
      expect(bySlug.get(slug).inherits_host_access).toBe(true);
    }
  });

  test('every status rule in the shipped vocabulary parses', () => {
    const { evaluateCondition } = require('../services/scheduler');
    const ctx = { metadata: {}, telemetry: {}, plugin: null, environment: null, bubbled_environment: null };
    for (const t of defaults) {
      for (const rule of t.status_rules || []) {
        expect(() => evaluateCondition(rule.condition, ctx)).not.toThrow();
      }
    }
  });

  test('every template is categorised, so the picker can group them', () => {
    expect(defaults.filter(t => !t.category).map(t => t.slug)).toEqual([]);
  });

  test('every declared schema property has a usable type or enum', () => {
    for (const t of defaults) {
      for (const [key, prop] of Object.entries((t.schema && t.schema.properties) || {})) {
        const ok = ['string', 'number', 'boolean', 'array'].includes(prop.type) || Array.isArray(prop.enum);
        expect(`${t.slug}.${key}:${ok}`).toBe(`${t.slug}.${key}:true`);
      }
    }
  });

  test('a required field is always one the schema declares', () => {
    for (const t of defaults) {
      const props = (t.schema && t.schema.properties) || {};
      for (const key of (t.schema && t.schema.required) || []) {
        expect(`${t.slug}:${key}:${key in props}`).toBe(`${t.slug}:${key}:true`);
      }
    }
  });

  test('every subtype with rules can reach a terminal status', () => {
    // A rule set with no catch-all leaves resources stuck at 'unknown'.
    for (const t of defaults) {
      const rules = t.status_rules || [];
      if (!rules.length) continue;
      expect(rules[rules.length - 1].condition).toBe('true');
    }
  });
});

describe('templateFor reads the cache, and fails safe without it', () => {
  const host = (subType) => ({ kind: 'host', metadata: { subType } });
  const service = (subType) => ({ kind: 'service', metadata: { subType } });

  test('with no cache it falls back to the bootstrap tables', () => {
    _setTemplateCache(null);
    expect(templateFor(host('linux')).sshCapable).toBe(true);
    expect(templateFor(host('ilo')).sshCapable).toBe(false);
    expect(templateFor(service('systemd')).inheritsHost).toBe(true);
    expect(templateFor(service('web')).inheritsHost).toBe(false);
  });

  test('a cached template decides for a subtype the bootstrap tables never knew', () => {
    _setTemplateCache({ 'my-appliance': { sshCapable: true, inheritsHost: false } });
    expect(templateFor(host('my-appliance')).sshCapable).toBe(true);
    _setTemplateCache({ 'my-appliance': { sshCapable: false, inheritsHost: false } });
    expect(templateFor(host('my-appliance')).sshCapable).toBe(false);
  });

  test('a template can never make an out-of-band controller a shell', () => {
    // NEVER_SSH is a fact about the hardware, not a preference. An accidental
    // tick of ssh_capable on a BMC must not put it in the jump-target list.
    _setTemplateCache({ ilo: { sshCapable: true, inheritsHost: false } });
    expect(templateFor(host('ilo')).sshCapable).toBe(false);
    expect(templateFor(host('idrac')).sshCapable).toBe(false);
  });

  test('an unknown subtype with no template is not a jump target', () => {
    _setTemplateCache({});
    expect(templateFor(host('something-nobody-defined')).sshCapable).toBe(false);
  });
});
