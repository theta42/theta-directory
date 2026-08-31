'use strict';

const { initORM } = require('../models');
const { Resource } = require('../models/resource');

describe('Resource optional name and slug generation', () => {
  beforeAll(async () => {
    await initORM();
  });

  beforeEach(async () => {
    const list = await Resource.list();
    for (const r of list) await r.delete();
  });

  test('auto-generates slug and fallback name when both are omitted for service', async () => {
    const res = await Resource.create({
      kind: 'service',
      metadata: { subType: 'ssh' }
    });

    expect(res.id).toBeDefined();
    expect(res.name).toBe('Ssh service');
    expect(res.slug).toMatch(/^app_ssh_service/);
  });

  test('auto-generates slug and fallback name when both are omitted for host', async () => {
    const res = await Resource.create({
      kind: 'host',
      metadata: { subType: 'lxc' }
    });

    expect(res.id).toBeDefined();
    expect(res.name).toBe('Lxc host');
    expect(res.slug).toMatch(/^host_lxc_host/);
  });

  test('auto-generates slug from custom name when slug is omitted', async () => {
    const res = await Resource.create({
      kind: 'service',
      name: 'Custom Web Portal'
    });

    expect(res.id).toBeDefined();
    expect(res.name).toBe('Custom Web Portal');
    expect(res.slug).toBe('app_custom_web_portal');
  });

  test('generates collision-resistant unique slug when identical names are created', async () => {
    const res1 = await Resource.create({
      kind: 'host',
      name: 'Database Node'
    });
    const res2 = await Resource.create({
      kind: 'host',
      name: 'Database Node'
    });

    expect(res1.slug).toBe('host_database_node');
    expect(res2.slug).toMatch(/^host_database_node_[a-f0-9]{6}$/);
    expect(res1.slug).not.toBe(res2.slug);
  });
});
