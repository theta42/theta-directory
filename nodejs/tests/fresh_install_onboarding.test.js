'use strict';
// Fresh master install: bootstrap/bootstrap.js seeds the stack host, then
// setup.sh installs theta-agent on that SAME machine and it enrols. The agent
// must ADOPT the seeded row, not add a second one -- otherwise the master
// appears twice in its own directory, with the stack's services under
// bootstrap's row and the agent plus every telemetry sample under the
// placeholder.
//
// The scenarios below are the variations a real install produces. The MAC ones
// matter most: the directory matches by MAC first, and until setup.sh was fixed
// it recorded the DEFAULT ROUTE interface while theta-agent reports the first
// non-virtual one -- different NICs on any multi-NIC or bridged host. A wrong
// MAC is worse than a missing one, because the MAC-hijack guard in
// resource_matcher.js then refuses the IP fallback as well.
const crypto = require('crypto');
jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(async () => null), set: jest.fn(async () => {}),
  request: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}));
const { initORM } = require('../models');
const { Resource, ResourceEdge } = require('../models/resource');
const agentManager = require('../utils/agent_manager');

const HOSTNAME = 'theta-master-01';
const MAC = 'aa:bb:cc:11:22:33';
const IP  = '192.168.1.10';

const stub = (o={}) => { const r={ id:o.id||crypto.randomUUID(), name:o.name||'a', resourceId:o.resourceId||null, revoked:false, persisted:{} };
  r.update = jest.fn(async p => { Object.assign(r.persisted,p); Object.assign(r,p); return r; }); return r; };

beforeAll(async () => { await initORM(); });
beforeEach(async () => {
  for (const r of await Resource.list().catch(()=>[])) await r.delete().catch(()=>{});
  for (const e of await ResourceEdge.list().catch(()=>[])) await e.delete().catch(()=>{});
});

// setup.sh derives the MAC from /sys/class/net/<iface>/address and leaves it
// EMPTY when it cannot pick an interface; the IP can also have moved (DHCP)
// between setup.sh and the agent install. Each variation is a fresh install
// that really happens.
const scenarios = [
  ['MAC and IP both match',   { macAddress: MAC, ip: IP },  { mac: MAC, ip: IP }],
  ['seeded host has no MAC',  { ip: IP },                   { mac: MAC, ip: IP }],
  ['IP moved since setup',    { macAddress: MAC, ip: '192.168.1.99' }, { mac: MAC, ip: IP }],
  // Both absent from the seeded row is the one case nothing can rescue: see
  // the separate test below, which pins that as known and explains why.
];

test.each(scenarios)('adopts rather than duplicates: %s', async (_label, seededFacts, reported) => {
  const now = Math.floor(Date.now()/1000);
  // 1. What bootstrap/bootstrap.js seeds (slug host_<name>, real facts).
  const site = await Resource.create({ id: crypto.randomUUID(), kind:'site', name:'local',
    slug:'site_local', metadata:{ isCurrentSite:true }, created_on:now });
  const seeded = await Resource.create({ id: crypto.randomUUID(), kind:'host', name:HOSTNAME,
    slug:`host_${HOSTNAME}`, metadata:{ subType:'linux', os:'Debian 12', sshPort:22,
      managed:true, ...seededFacts }, created_on:now });
  await ResourceEdge.create({ id: crypto.randomUUID(), parentId:site.id, childId:seeded.id, relation:'hosts' });

  // 2. What join-key enrolment creates: a placeholder host + the agent service.
  const placeholder = await Resource.create({ id: crypto.randomUUID(), kind:'host', name:HOSTNAME,
    slug:`host-${HOSTNAME}`, metadata:{ subType:'linux', managed:true }, created_on:now });
  const agentSvc = await Resource.create({ id: crypto.randomUUID(), kind:'service', name:'Theta Agent',
    slug:`svc-${HOSTNAME}-theta-agent`, metadata:{ subType:'theta-agent', managed:true }, created_on:now });
  await ResourceEdge.create({ id: crypto.randomUUID(), parentId:placeholder.id, childId:agentSvc.id, relation:'hosts' });

  // 3. The agent's first discovery frame, through the real entry point.
  const agent = stub({ name: HOSTNAME, resourceId: agentSvc.id });
  await agentManager.handleDiscovery(agent, {
    hostname: HOSTNAME, mac_address: reported.mac, ip_addresses: [reported.ip],
    os: 'linux debian', kernel: '6.1.0', ram_total_gb: 32, version: 'v2.22.1',
  });

  const hosts = await Resource.list({ where: { kind: 'host' } });
  console.log(`[${_label}] hosts after enrol:`, hosts.map(h => h.slug).sort().join(' + '));
  expect(hosts).toHaveLength(1);
  expect(hosts[0].slug).toBe(`host_${HOSTNAME}`);
  // The seeded row keeps its operator-facing facts and gains the agent's.
  expect(hosts[0].metadata.sshPort).toBe(22);
  expect(hosts[0].metadata.discovery_sources).toContain('theta-agent');
});

// Why setup.sh has to agree with the agent rather than the matcher being
// loosened. This is the failure the fix prevents at the source, pinned here so
// the reason survives: a WRONG MAC on the seeded row is unrecoverable, because
// the MAC-hijack guard (resource_matcher.js matchByIp) refuses to match a
// candidate that already has an identity of its own -- even when the IP is an
// exact match. Loosening that guard would re-open the hijack it exists to stop,
// so the producers are aligned instead (setup.sh mirrors collectPrimaryMAC).
test('a MAC that disagrees with the agent cannot be rescued by a matching IP', async () => {
  const now = Math.floor(Date.now()/1000);
  const site = await Resource.create({ id: crypto.randomUUID(), kind:'site', name:'local',
    slug:'site_local', metadata:{ isCurrentSite:true }, created_on:now });
  const seeded = await Resource.create({ id: crypto.randomUUID(), kind:'host', name:HOSTNAME,
    slug:`host_${HOSTNAME}`, created_on:now,
    // The default route's interface -- a different NIC from the one the agent
    // reports, which is exactly what setup.sh used to record.
    metadata:{ subType:'linux', ip:IP, macAddress:'02:42:bb:bb:bb:bb', managed:true } });
  await ResourceEdge.create({ id: crypto.randomUUID(), parentId:site.id, childId:seeded.id, relation:'hosts' });

  const placeholder = await Resource.create({ id: crypto.randomUUID(), kind:'host', name:HOSTNAME,
    slug:`host-${HOSTNAME}`, metadata:{ subType:'linux', managed:true }, created_on:now });
  const agentSvc = await Resource.create({ id: crypto.randomUUID(), kind:'service', name:'Theta Agent',
    slug:`svc-${HOSTNAME}-theta-agent`, metadata:{ subType:'theta-agent', managed:true }, created_on:now });
  await ResourceEdge.create({ id: crypto.randomUUID(), parentId:placeholder.id, childId:agentSvc.id, relation:'hosts' });

  const agent = stub({ name: HOSTNAME, resourceId: agentSvc.id });
  await agentManager.handleDiscovery(agent, {
    hostname: HOSTNAME, mac_address: MAC, ip_addresses: [IP], os: 'linux debian',
  });

  const hosts = await Resource.list({ where: { kind: 'host' } });
  // Two rows, despite an exact IP match and an identical hostname. Documented,
  // not endorsed -- setup.sh is what stops this arising.
  expect(hosts).toHaveLength(2);
});
