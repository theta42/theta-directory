'use strict';

// Redfish fixture keyed by path (relative to the iLO base URL) -> JSON body.
// Mirrors the shape a real HPE iLO 5 returns for the endpoints ilo.js calls.
const FIXTURE = {
  '/redfish/v1/': {},
  '/redfish/v1/Systems/': { Members: [{ '@odata.id': '/redfish/v1/Systems/1/' }] },
  '/redfish/v1/Systems/1/': {
    HostName: 'web01',
    Model: 'ProLiant DL380 Gen10',
    Manufacturer: 'HPE',
    SerialNumber: 'ABC123XYZ',
    BiosVersion: 'U30 v2.86',
    PowerState: 'On',
    Status: { Health: 'OK' },
    ProcessorSummary: { Count: 2, Model: 'Intel Xeon Gold 6230' },
    MemorySummary: { TotalSystemMemoryGiB: 256 },
  },
  '/redfish/v1/Managers/': { Members: [{ '@odata.id': '/redfish/v1/Managers/1/' }] },
  '/redfish/v1/Managers/1/': { Model: 'iLO 5', FirmwareVersion: '2.78' },
  '/redfish/v1/Managers/1/EthernetInterfaces/': { Members: [{ '@odata.id': '/redfish/v1/Managers/1/EthernetInterfaces/1/' }] },
  '/redfish/v1/Managers/1/EthernetInterfaces/1/': {
    MACAddress: 'aa:bb:cc:dd:ee:01',
    IPv4Addresses: [{ Address: '10.0.0.50' }],
  },
  '/redfish/v1/Systems/1/EthernetInterfaces/': {
    Members: [
      { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces/1/' },
      { '@odata.id': '/redfish/v1/Systems/1/EthernetInterfaces/2/' },
    ],
  },
  '/redfish/v1/Systems/1/EthernetInterfaces/1/': {
    Name: 'NIC1', MACAddress: 'aa:bb:cc:dd:ee:11', IPv4Addresses: [{ Address: '10.0.1.10' }],
  },
  '/redfish/v1/Systems/1/EthernetInterfaces/2/': {
    Name: 'NIC2', MACAddress: 'aa:bb:cc:dd:ee:12', IPv4Addresses: [],
  },
};

jest.mock('node-fetch', () => jest.fn((url) => {
  const path = url.replace(/^https?:\/\/[^/]+/, '');
  const body = FIXTURE[path];
  if (!body) return Promise.resolve({ ok: false, status: 404, text: async () => 'not found' });
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}));

const ilo = require('../plugins/discovery/ilo');

describe('ilo discovery plugin manifest', () => {
  test('declares the expected type/category/configSchema shape', () => {
    expect(ilo.type).toBe('ilo');
    expect(ilo.category).toBe('discovery');
    const keys = ilo.configSchema.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(['url', 'username', 'password', 'hostSlug', 'location', 'autoPromote']));
    const password = ilo.configSchema.find((f) => f.key === 'password');
    expect(password.secret).toBe(true);
  });

  test('validate() rejects an incomplete config without making a request', async () => {
    const result = await ilo.validate({ url: 'https://ilo.example.com' });
    expect(result.ok).toBe(false);
  });

  test('discover() rejects an incomplete config without making a request', async () => {
    await expect(ilo.discover({ url: 'https://ilo.example.com' })).rejects.toThrow(/Missing iLO config/);
  });

  test('run() is an alias for discover()', () => {
    expect(ilo.run).toBeInstanceOf(Function);
  });
});

describe('ilo discovery plugin discover()', () => {
  const config = { url: 'https://ilo.example.com', username: 'Administrator', password: 'secret' };

  // kind is structural (site/host/service) -- a BMC is a host. What keeps it
  // from being folded into the server it manages is the `ilo` subtype's
  // identity_class, not a made-up kind. See services/subtype_templates.js.
  test('builds one host resource with subType ilo from the System + Manager Redfish data', async () => {
    const { resources, edges } = await ilo.discover(config);
    expect(edges).toEqual([]);
    expect(resources).toHaveLength(1);

    const r = resources[0];
    // Deliberately NOT 'host' -- see ilo.js's comment: this keeps the
    // generic reconciler from ever merging the iLO's own out-of-band
    // address into the server's real host resource.
    expect(r.kind).toBe('host');
    expect(r.metadata.subType).toBe('ilo');
    expect(r.name).toBe('web01');
    expect(r.slug).toBe('ilo-abc123xyz');
    expect(r.metadata).toMatchObject({
      subType: 'ilo',
      address: config.url,
      ip: '10.0.0.50',
      macAddress: 'aa:bb:cc:dd:ee:01',
      model: 'ProLiant DL380 Gen10',
      manufacturer: 'HPE',
      serial: 'ABC123XYZ',
      biosVersion: 'U30 v2.86',
      managerModel: 'iLO 5',
      firmware: '2.78',
      health: 'OK',
      powerState: 'On',
      cpuCount: 2,
      memoryGiB: 256,
      sourceId: 'ABC123XYZ',
    });
    // The host's own NICs, distinct from the iLO's own management NIC above.
    expect(r.metadata.interfaces).toEqual([
      { mac: 'aa:bb:cc:dd:ee:11', ip: '10.0.1.10', ips: ['10.0.1.10'], name: 'NIC1' },
      { mac: 'aa:bb:cc:dd:ee:12', ip: null, ips: [], name: 'NIC2' },
    ]);
    expect(r.metadata.hostIp).toBe('10.0.1.10');
    expect(r.metadata.hostMac).toBe('aa:bb:cc:dd:ee:11');
  });

  test('hostSlug produces an edge linking the bmc resource to the server resource', async () => {
    const { resources, edges } = await ilo.discover({ ...config, hostSlug: 'host_web01' });
    expect(edges).toEqual([{ parentSlug: 'host_web01', childSlug: resources[0].slug, relation: 'bmc' }]);
  });

  // `environment` is what an operator declares a resource to be (prod/testing/
  // dev) and it bubbles UP the graph, so deriving it from power state would
  // re-label a host, its cluster and its whole site every time a machine was
  // powered off. The plugin reports the power state as the fact it actually
  // observed, and nothing more.
  test('power state is reported as powerState and never as an environment', async () => {
    const offPath = '/redfish/v1/Systems/1/';
    const original = FIXTURE[offPath];
    FIXTURE[offPath] = { ...original, PowerState: 'Off' };
    try {
      const { resources } = await ilo.discover(config);
      expect(resources[0].metadata.powerState).toBe('Off');
      expect(resources[0].metadata.environment).toBeUndefined();
    } finally {
      FIXTURE[offPath] = original;
    }

    const { resources: onResources } = await ilo.discover(config);
    expect(onResources[0].metadata.powerState).toBe('On');
    expect(onResources[0].metadata.environment).toBeUndefined();
  });
});
