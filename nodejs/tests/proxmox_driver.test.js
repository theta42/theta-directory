'use strict';

const ProxmoxDriver = require('../drivers/proxmox_driver');
const { initORM } = require('../models');
const { Resource, ResourceEdge } = require('../models/resource');

describe('ProxmoxDriver', () => {
  let driver;

  beforeAll(async () => {
    await initORM();
    driver = new ProxmoxDriver();
  });

  beforeEach(async () => {
    const edges = await ResourceEdge.list();
    for (const e of edges) await e.delete();
    const list = await Resource.list();
    for (const r of list) await r.delete();
  });

  test('supports all relevant proxmox hypervisor and guest subtypes', () => {
    expect(driver.supports({ metadata: { subType: 'proxmox' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'hypervisor' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'server-proxmox' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'lxc' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'proxmox-lxc' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'vm' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'kvm' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'proxmox-kvm' } })).toBe(true);
    expect(driver.supports({ metadata: { subType: 'docker' } })).toBe(false);
  });

  test('returns fallback metrics with guestStats for unconfigured LXC guest', async () => {
    const parent = await Resource.create({
      kind: 'host',
      name: 'PVE Node 1',
      metadata: { subType: 'hypervisor', node: 'pve1' }
    });
    const guest = await Resource.create({
      kind: 'host',
      name: 'DNS Server Container',
      metadata: { subType: 'lxc', vmid: 105, powerState: 'running' }
    });
    await ResourceEdge.create({
      parentId: parent.id,
      childId: guest.id,
      relation: 'hosts'
    });

    const metrics = await driver.getMetrics(guest);
    expect(metrics.status).toBe('online');
    expect(metrics.driver).toBe('proxmox');
    expect(metrics.vmid).toBe(105);
    expect(metrics.hypervisor).toEqual({
      id: parent.id,
      name: 'PVE Node 1',
      slug: parent.slug
    });
    expect(metrics.guestStats).toBeDefined();
    expect(metrics.guestStats.vmid).toBe(105);
    expect(metrics.guestStats.type).toBe('lxc');
    expect(metrics.guestStats.status).toBe('running');
  });

  test('execAction dispatches power control actions (start, stop, reboot, shutdown, suspend, resume)', async () => {
    const guest = await Resource.create({
      kind: 'host',
      name: 'Test VM',
      metadata: { subType: 'vm', vmid: 201 }
    });

    const startRes = await driver.execAction(guest, 'start');
    expect(startRes.status).toBe('ok');
    expect(startRes.action).toBe('start');
    expect(startRes.vmid).toBe(201);

    const rebootRes = await driver.execAction(guest, 'reboot');
    expect(rebootRes.status).toBe('ok');
    expect(rebootRes.action).toBe('reboot');

    const stopRes = await driver.execAction(guest, 'stop');
    expect(stopRes.status).toBe('ok');
    expect(stopRes.action).toBe('stop');

    const invalidRes = await driver.execAction(guest, 'explode');
    expect(invalidRes.status).toBe('error');
    expect(invalidRes.message).toMatch(/Unsupported Proxmox action/);
  });
});
