'use strict';

// jump_client now computes the gateway count locally from the MeshSite table
// (the roster lives in the directory in mesh v2), so the tests mock that table
// rather than the deleted /api/mesh/gateways HTTP endpoint.

const mockRows = { sites: [] };
jest.mock('../models/mesh_site', () => ({
  MeshSite: { list: async () => mockRows.sites }
}));

describe('jump_client', () => {
  let jumpClient;

  beforeEach(() => {
    jest.resetModules();
    mockRows.sites = [];
    jumpClient = require('../utils/jump_client');
  });

  test('counts only sites that have published a gateway public key', async () => {
    mockRows.sites = [
      { siteId: 1, slug: 'hq', gatewayPublicKey: 'pub-1' },
      { siteId: 2, slug: 'branch', gatewayPublicKey: '' },
      { siteId: 3, slug: 'branch2', gatewayPublicKey: 'pub-3' }
    ];
    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBe(2);
    expect(result.note).toBe('ok');
  });

  test('reports zero gateways when none have published', async () => {
    mockRows.sites = [
      { siteId: 1, slug: 'hq', gatewayPublicKey: '' },
      { siteId: 2, slug: 'branch', gatewayPublicKey: '' }
    ];
    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBe(0);
    expect(result.note).toBe('ok');
  });

  test('reports null count (not zero) when the table query fails', async () => {
    const { MeshSite } = require('../models/mesh_site');
    MeshSite.list = async () => { throw new Error('table gone'); };
    const result = await jumpClient.getGatewayCount();
    expect(result.count).toBeNull();
    expect(result.note).toMatch(/failed: table gone/);
  });
});
