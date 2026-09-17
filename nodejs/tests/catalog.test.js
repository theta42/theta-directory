'use strict';

// The catalog at `/` is a curated launchpad, not a render of the directory.
//
// Two separate failures are pinned here, because both were live:
//
//  1. The page showed every managed resource it could see. On a directory with
//     a Proxmox cluster in it, a user with NO access at all was shown 76 cards
//     -- 41 LXC containers, 12 VMs, 3 hypervisors -- 27 of which had no address
//     to reach them by. That is not discovery, and it published the shape of
//     the estate to anyone with an account.
//
//  2. Status could not be shown on a catalog entry at all. Bubbling rolls the
//     worst state UP to a parent, which is right for "how is this site doing"
//     and useless for a leaf sitting beside its own backing services.

const { Resource } = require('../models/resource');
const { ensurePluginCatalogEntry, urlFieldKey, endpointFromUrl } = require('../services/plugin_catalog_entry');

// ---------------------------------------------------------------------------
// The predicate the launchpad filters on. Kept in step with views/landing.ejs
// isCatalogEntry(); a copy here so the rule can be tested without a DOM.
const OAUTH_SUBTYPES = ['oauth', 'oidc-client', 'saml-sp'];
function isCatalogEntry(r) {
  if (!r || r.kind !== 'service') return false;
  const md = r.metadata || {};
  if (OAUTH_SUBTYPES.includes(String(md.subType || '').toLowerCase())) return false;
  return md.catalog === true;
}

const svc = (slug, md) => ({ id: slug, kind: 'service', slug, name: slug, metadata: md });
const host = (slug, md) => ({ id: slug, kind: 'host', slug, name: slug, metadata: md });

describe('what reaches the catalog', () => {
  test('hosts never do, however they are marked', () => {
    // Service discovery and host discovery are different jobs for different
    // audiences. Browsing machines lives in the directory.
    expect(isCatalogEntry(host('lxc-emby', { catalog: true, managed: true }))).toBe(false);
    expect(isCatalogEntry(host('pve-node-dl380-0', { managed: true }))).toBe(false);
  });

  test('a managed service is not a catalog entry by itself', () => {
    // `managed` is inventory and nearly everything carries it; `catalog` is
    // presentation and a handful do. Collapsing the two is the original bug.
    expect(isCatalogEntry(svc('svc-docker-bao-renewer', { subType: 'docker', managed: true }))).toBe(false);
    expect(isCatalogEntry(svc('svc-theta-agent', { subType: 'theta-agent', managed: true }))).toBe(false);
  });

  test('credential registrations never reach it, even when marked', () => {
    // The old page applied this filter to the "discover more" list but NOT to
    // the list of things you already have -- and every operator holds access
    // to the proxy and jump-host OAuth clients, so they were offered as
    // service cards despite a comment saying they were filtered out.
    for (const sub of OAUTH_SUBTYPES) {
      expect(isCatalogEntry(svc(`client-${sub}`, { subType: sub, catalog: true, managed: true }))).toBe(false);
    }
  });

  test('a marked http service does', () => {
    expect(isCatalogEntry(svc('emby-http', { subType: 'http', catalog: true }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('catalog status resolution', () => {
  // The real shape from the instance this was designed against:
  //
  //   lxc-emby            status=ok       (the appliance)
  //     +- theta-agent    status=ok
  //     +- emby-server    status=ok       (systemd)
  //     +- emby_http      status=unknown  <- the catalog entry, a SIBLING
  //
  // The entry has no children, so it bubbles nothing.
  function graph(resources, edges) {
    const orig = Resource.getGraph;
    Resource.getGraph = async () => ({ resources, edges });
    return () => { Resource.getGraph = orig; };
  }

  test('an entry with no status of its own takes the nearest host', async () => {
    const entry = svc('emby_http', { subType: 'http', catalog: true, status: 'unknown' });
    const lxc = host('lxc-emby', { status: 'ok' });
    const restore = graph([entry, lxc], [{ parentId: 'lxc-emby', childId: 'emby_http' }]);
    try {
      const [out] = await Resource.withCatalogStatus([entry]);
      expect(out.catalogStatus.state).toBe('ok');
      expect(out.catalogStatus.via).toBe('ancestor');
    } finally { restore(); }
  });

  test("it reads the host's own status, never the bubbled one", async () => {
    // The entry is itself a child of that host, so its `unknown` is already
    // folded into the host's bubbled value. Reading that back would be the
    // card consuming its own ignorance -- and it could never go green.
    const entry = svc('emby_http', { subType: 'http', status: 'unknown' });
    const lxc = host('lxc-emby', { status: 'ok', bubbled_status: 'unknown' });
    const restore = graph([entry, lxc], [{ parentId: 'lxc-emby', childId: 'emby_http' }]);
    try {
      const [out] = await Resource.withCatalogStatus([entry]);
      expect(out.catalogStatus.state).toBe('ok');
    } finally { restore(); }
  });

  test('its own status wins when it has one', async () => {
    const entry = svc('emby_http', { subType: 'http', status: 'critical' });
    const lxc = host('lxc-emby', { status: 'ok' });
    const restore = graph([entry, lxc], [{ parentId: 'lxc-emby', childId: 'emby_http' }]);
    try {
      const [out] = await Resource.withCatalogStatus([entry]);
      expect(out.catalogStatus.state).toBe('critical');
      expect(out.catalogStatus.via).toBe('self');
      expect(out.catalogStatus.from).toBe(null);
    } finally { restore(); }
  });

  test('a negative answer keeps climbing, and names the real culprit', async () => {
    // A dead hypervisor explains every guest on it. Saying "emby is down"
    // there is true but actively misleading.
    const entry = svc('emby_http', { subType: 'http', status: 'unknown' });
    const lxc = host('lxc-emby', { status: 'critical' });
    const node = host('pve-node-dl380-0', { status: 'critical' });
    const restore = graph(
      [entry, lxc, node],
      [{ parentId: 'lxc-emby', childId: 'emby_http' },
       { parentId: 'pve-node-dl380-0', childId: 'lxc-emby' }]);
    try {
      const [out] = await Resource.withCatalogStatus([entry]);
      expect(out.catalogStatus.state).toBe('critical');
      expect(out.catalogStatus.from).toBe('pve-node-dl380-0');
    } finally { restore(); }
  });

  test('a healthy ancestor above a sick one does not clear the sick one', async () => {
    const entry = svc('emby_http', { subType: 'http', status: 'unknown' });
    const lxc = host('lxc-emby', { status: 'critical' });
    const node = host('pve-node-dl380-0', { status: 'ok' });
    const restore = graph(
      [entry, lxc, node],
      [{ parentId: 'lxc-emby', childId: 'emby_http' },
       { parentId: 'pve-node-dl380-0', childId: 'lxc-emby' }]);
    try {
      const [out] = await Resource.withCatalogStatus([entry]);
      expect(out.catalogStatus.state).toBe('critical');
      expect(out.catalogStatus.from).toBe('lxc-emby');
    } finally { restore(); }
  });

  test('nameCulprit:false keeps the state and drops the name', async () => {
    // The "things you could request" half covers resources the caller has no
    // access to. Naming the hypervisor behind one discloses the shape of the
    // estate to someone the projection is otherwise hiding it from.
    const entry = svc('emby_http', { subType: 'http', status: 'unknown' });
    const lxc = host('lxc-emby', { status: 'critical' });
    const restore = graph([entry, lxc], [{ parentId: 'lxc-emby', childId: 'emby_http' }]);
    try {
      const [out] = await Resource.withCatalogStatus([entry], { nameCulprit: false });
      expect(out.catalogStatus.state).toBe('critical');
      expect(out.catalogStatus.from).toBe(null);
    } finally { restore(); }
  });

  test('an entry with no host at all is unknown, not an error', async () => {
    // An external SaaS link is a legitimate catalog entry with no parent.
    const entry = svc('wiki', { subType: 'http', fqdn: 'wiki.example.com' });
    const restore = graph([entry], []);
    try {
      const [out] = await Resource.withCatalogStatus([entry]);
      expect(out.catalogStatus.state).toBe('unknown');
      expect(out.catalogStatus.via).toBe('none');
    } finally { restore(); }
  });

  test('a parent cycle terminates', async () => {
    const a = host('a', { status: 'unknown' });
    const b = host('b', { status: 'unknown' });
    const entry = svc('e', { subType: 'http' });
    const restore = graph([a, b, entry], [
      { parentId: 'a', childId: 'b' },
      { parentId: 'b', childId: 'a' },
      { parentId: 'a', childId: 'e' },
    ]);
    try {
      const [out] = await Resource.withCatalogStatus([entry]);
      expect(out.catalogStatus.state).toBe('unknown');
    } finally { restore(); }
  });
});

// ---------------------------------------------------------------------------
describe('plugin-created entries', () => {
  test('a url field in the manifest is the signal, and nmap has none', () => {
    expect(urlFieldKey({ configSchema: [{ key: 'url', type: 'url' }] })).toBe('url');
    expect(urlFieldKey({ configSchema: [{ key: 'cidr', type: 'text' }] })).toBe(null);
    expect(urlFieldKey({})).toBe(null);
  });

  test('a url splits into the http subtype external shape', () => {
    expect(endpointFromUrl('https://pve.example:8006')).toEqual({
      fqdn: 'pve.example', externalIsHTTPS: true, externalPort: 8006,
      address: 'https://pve.example:8006',
    });
    // A default port is filled in rather than left blank.
    expect(endpointFromUrl('https://ilo.example.com').externalPort).toBe(443);
    expect(endpointFromUrl('http://unifi.local').externalPort).toBe(80);
  });

  test('anything not http(s) is skipped rather than guessed at', () => {
    // A card pointing at a malformed address is worse than no card.
    expect(endpointFromUrl('ssh://jump.example:2222')).toBe(null);
    expect(endpointFromUrl('not a url')).toBe(null);
    expect(endpointFromUrl('')).toBe(null);
  });

  test('an existing entry is never re-asserted', async () => {
    // Discovery re-runs on a schedule. An admin who unticks "Show in catalog"
    // or renames the entry must not have it undone on the next tick.
    const orig = Resource.getBySlug;
    const origCreate = Resource.create;
    let created = false;
    Resource.getBySlug = async () => ({ id: 'x', slug: 'plugin-pve0-ui', metadata: { catalog: false } });
    Resource.create = async () => { created = true; };
    try {
      const out = await ensurePluginCatalogEntry(
        { slug: 'pve0', pluginType: 'proxmox' },
        { name: 'Proxmox VE', configSchema: [{ key: 'url', type: 'url' }] },
        { url: 'https://pve.example:8006' });
      expect(out).toBe(null);
      expect(created).toBe(false);
    } finally { Resource.getBySlug = orig; Resource.create = origCreate; }
  });

  test('a plugin with no url field creates nothing', async () => {
    const origCreate = Resource.create;
    let created = false;
    Resource.create = async () => { created = true; };
    try {
      const out = await ensurePluginCatalogEntry(
        { slug: 'nmap0', pluginType: 'nmap' },
        { name: 'nmap', configSchema: [{ key: 'cidr', type: 'text' }] },
        { cidr: '192.168.1.0/24' });
      expect(out).toBe(null);
      expect(created).toBe(false);
    } finally { Resource.create = origCreate; }
  });
});
