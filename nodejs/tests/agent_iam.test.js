'use strict';

// Node IAM payload derivation (utils/agent_iam.js).
//
// `iam_apply` had no caller in this directory at all, so the agent's entire IAM
// engine was unreachable. What this builder may and may not derive is a
// deliberate, narrow set -- see the header of utils/agent_iam.js -- and these
// tests are what hold that line.

const crypto = require('crypto');

jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
  request: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}), { virtual: true });

const { initORM } = require('../models');
const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { buildNodeIAM } = require('../utils/agent_iam');

const mk = (kind, name, slug, metadata = {}) => Resource.create({
  id: crypto.randomUUID(), kind, name, slug, metadata,
  created_on: Math.floor(Date.now() / 1000)
});
const edge = (parentId, childId) => ResourceEdge.create({
  id: crypto.randomUUID(), parentId, childId, relation: 'hosts'
});

describe('node IAM payload', () => {
  let site;
  let host;

  beforeAll(async () => {
    await initORM();
  });

  beforeEach(async () => {
    for (const r of await Resource.list().catch(() => [])) await r.delete().catch(() => {});
    for (const e of await ResourceEdge.list().catch(() => [])) await e.delete().catch(() => {});
    for (const g of await ResourceGroup.list().catch(() => [])) await g.delete().catch(() => {});

    site = await mk('site', 'local', 'site_local');
    host = await mk('host', 'emby', 'host_emby', { subType: 'linux' });
    await edge(site.id, host.id);
  });

  test('the structural groups for the host and its site may log in', async () => {
    const payload = await buildNodeIAM(host);
    expect(payload.node_id).toBe('host_emby');
    expect(payload.access_control.allowed_login_groups).toEqual([
      'god_admin',
      'site_local_host_emby_access',
      'site_local_host_emby_admin',
      'site_local_hosts_access',
      'site_local_hosts_admin',
      'site_local_super_admin'
    ]);
  });

  test('a grant on an ANCESTOR reaches the host', async () => {
    // Ownership propagates down the tree: granting a site grants what is in it.
    // Reading only the rows attached to this host would miss most real access.
    await ResourceGroup.ensure(site.id, 'ops-oncall', 'admin');
    const payload = await buildNodeIAM(host);
    expect(payload.access_control.allowed_login_groups).toContain('ops-oncall');
  });

  test('catalog visibility is not a login', async () => {
    await ResourceGroup.ensure(host.id, 'auditors', 'viewer');
    await ResourceGroup.ensure(host.id, 'deployers', 'access');
    const { allowed_login_groups: allowed } = (await buildNodeIAM(host)).access_control;
    // viewer/member means "can see it in the directory", not "has a shell".
    expect(allowed).not.toContain('auditors');
    expect(allowed).toContain('deployers');
  });

  test('a meta group never lands in access.conf', async () => {
    // The file the agent writes ends in `-:ALL:ALL`; putting `everyone` above
    // that line makes the deny meaningless.
    await ResourceGroup.ensure(host.id, 'everyone', 'access');
    await ResourceGroup.ensure(host.id, 'site_local_everyone', 'admin');
    const { allowed_login_groups: allowed } = (await buildNodeIAM(host)).access_control;
    expect(allowed).not.toContain('everyone');
    expect(allowed).not.toContain('site_local_everyone');
  });

  test('a grant on an unrelated host does not leak in', async () => {
    const other = await mk('host', 'other', 'host_other');
    await edge(site.id, other.id);
    await ResourceGroup.ensure(other.id, 'other-team', 'admin');
    const { allowed_login_groups: allowed } = (await buildNodeIAM(host)).access_control;
    expect(allowed).not.toContain('other-team');
  });

  test('sudo rules, SSH keys and revocations are deliberately empty', async () => {
    await ResourceGroup.ensure(host.id, 'ops-oncall', 'admin');
    const { access_control: ac } = await buildNodeIAM(host);
    // The only sudo rule derivable from "admin on this host" is ALL/ALL, which
    // is the landmine H12 removed from the LDAP side. Scoped sudo is design gap
    // D5; until it exists this stays empty rather than shipping universal root.
    expect(ac.sudo_rules).toEqual([]);
    // The agent serves an AuthorizedKeysCommand per login; a pushed snapshot
    // would go stale.
    expect(ac.ssh_keys).toEqual([]);
    // A revocation list computed at push time lists people already gone.
    expect(ac.revoke_users).toEqual([]);
  });

  test('a host at no site yields no policy rather than a deny-all', async () => {
    const orphan = await mk('host', 'orphan', 'host_orphan');
    // Every structural group is site-scoped, so there is nothing to allow --
    // and the file the agent writes would deny every LDAP user on the machine.
    expect(await buildNodeIAM(orphan)).toBeNull();
  });

  test('only a host has node IAM', async () => {
    const svc = await mk('service', 'nginx', 'svc-emby-systemd-nginx', { subType: 'systemd' });
    await edge(host.id, svc.id);
    expect(await buildNodeIAM(svc)).toBeNull();
    expect(await buildNodeIAM(null)).toBeNull();
  });
});
