'use strict';

const mockInstances = { rows: [] };
jest.mock('../models/plugin_instance', () => ({
  PluginInstance: { list: async ({ where }) => mockInstances.rows.filter((r) => r.slug === where.slug && r.pluginType === where.pluginType) },
}));

const mockSecrets = { byId: {} };
jest.mock('../utils/plugin_secrets', () => ({
  mergeForRun: async (instance) => mockSecrets.byId[instance.id] || {},
}));

const FIXTURE = {
  '/redfish/v1/Systems/': { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] },
  '/redfish/v1/Systems/1/': {
    PowerState: 'On',
    Status: { Health: 'OK', State: 'Enabled' },
    Model: 'ProLiant DL380 Gen10',
    SerialNumber: 'ABC123XYZ',
    Actions: { '#ComputerSystem.Reset': { target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset' } },
  },
};

let lastResetCall = null;
jest.mock('node-fetch', () => jest.fn((url, opts) => {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  if (opts && opts.method === 'POST' && path === '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset') {
    lastResetCall = { url, body: JSON.parse(opts.body) };
    return Promise.resolve({ ok: true, status: 200, text: async () => '' });
  }
  const body = FIXTURE[path];
  if (!body) return Promise.resolve({ ok: false, status: 404, text: async () => 'not found' });
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}));

const IloDriver = require('../drivers/ilo_driver');

describe('IloDriver', () => {
  let driver;
  const resource = { id: 'r1', metadata: { subType: 'ilo', discovery_sources: ['ilo-web01'] } };

  beforeEach(() => {
    driver = new IloDriver();
    lastResetCall = null;
    mockInstances.rows = [{ id: 'inst-1', slug: 'ilo-web01', pluginType: 'ilo' }];
    mockSecrets.byId['inst-1'] = { url: 'https://ilo.example.com', username: 'Administrator', password: 'secret' };
  });

  test('supports() only matches subType ilo', () => {
    expect(driver.supports(resource)).toBe(true);
    expect(driver.supports({ metadata: { subType: 'proxmox' } })).toBe(false);
    expect(driver.supports(null)).toBe(false);
  });

  test('getMetrics() reports live power/health state from Redfish', async () => {
    const metrics = await driver.getMetrics(resource);
    expect(metrics.status).toBe('online');
    expect(metrics.ilo).toMatchObject({ powerState: 'On', health: 'OK', model: 'ProLiant DL380 Gen10', serial: 'ABC123XYZ' });
  });

  test('getMetrics() reports offline when no plugin instance resolves', async () => {
    mockInstances.rows = [];
    const metrics = await driver.getMetrics(resource);
    expect(metrics.status).toBe('offline');
  });

  test('execAction("reboot") POSTs ComputerSystem.Reset with GracefulRestart', async () => {
    const result = await driver.execAction(resource, 'reboot');
    expect(result.status).toBe('ok');
    expect(lastResetCall.body).toEqual({ ResetType: 'GracefulRestart' });
  });

  test('execAction("power_on") maps to ResetType "On"', async () => {
    await driver.execAction(resource, 'power_on');
    expect(lastResetCall.body).toEqual({ ResetType: 'On' });
  });

  test('execAction() rejects an unsupported action without making a request', async () => {
    const result = await driver.execAction(resource, 'nonexistent_action');
    expect(result.status).toBe('error');
    expect(lastResetCall).toBeNull();
  });

  test('execAction() errors clearly when no plugin instance resolves', async () => {
    mockInstances.rows = [];
    const result = await driver.execAction(resource, 'reboot');
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/No iLO plugin instance/);
  });
});
