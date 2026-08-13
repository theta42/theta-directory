'use strict';

const fetch = require('node-fetch');
const https = require('https');

// Custom agent to bypass the self-signed cert every iLO ships with out of
// the box (same reasoning as plugins/discovery/proxmox.js).
const agent = new https.Agent({ rejectUnauthorized: false });

// One config = one physical server's iLO (Redfish), unlike proxmox.js's
// one-endpoint-covers-a-cluster shape -- an iLO's Systems/Managers
// collections each have exactly one real member, so there is no fan-out to
// do here. `id` is the Redfish member id (e.g. "1") resolved from the
// collection rather than hardcoded, since it is not guaranteed across iLO
// generations/configs.
async function resolveMemberPath(url, headers, collectionPath) {
  const res = await fetch(`${url}${collectionPath}`, { headers, agent });
  if (!res.ok) throw new Error(`Redfish ${collectionPath} error: ${res.status}`);
  const body = await res.json();
  const first = (body.Members || [])[0];
  if (!first || !first['@odata.id']) throw new Error(`Redfish ${collectionPath} returned no members`);
  return first['@odata.id'];
}

async function getJson(url, path, headers) {
  const res = await fetch(`${url}${path}`, { headers, agent });
  if (!res.ok) throw new Error(`Redfish ${path} error: ${res.status}`);
  return res.json();
}

module.exports = {
  // Plugin manifest -- see nodejs/services/plugin_registry.js.
  type: 'ilo',
  category: 'discovery',
  name: 'HP iLO',
  description: 'Discover a physical server\'s model/serial/firmware/health/power state from its HP iLO (Redfish) management interface.',
  configSchema: [
    { key: 'url',      label: 'iLO URL',  type: 'url',      required: true, placeholder: 'https://ilo.example.com' },
    { key: 'username', label: 'Username', type: 'text',     required: true, placeholder: 'Administrator' },
    { key: 'password', label: 'Password', type: 'password', required: true, secret: true },
    { key: 'location',    label: 'Location / Site (optional)', type: 'site_select', required: false, placeholder: 'Default Site' },
    { key: 'autoPromote', label: 'Auto-promote to Directory',  type: 'boolean',     required: false, default: false }
  ],

  // "Test" button in the UI: a cheap authenticated read confirms the URL +
  // credentials work before the instance is ever scheduled.
  validate: async (config) => {
    const { url, username, password } = config;
    if (!url || !username || !password) return { ok: false, error: 'Missing url, username, or password' };
    try {
      const headers = { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') };
      const res = await fetch(`${url.replace(/\/+$/, '')}/redfish/v1/`, { headers, agent });
      if (!res.ok) return { ok: false, error: `iLO rejected the request (${res.status})` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  discover: async (config) => {
    let { url, username, password } = config;
    if (!url || !username || !password) throw new Error('Missing iLO config');
    url = url.replace(/\/+$/, '');

    const headers = { Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64') };

    const systemPath = await resolveMemberPath(url, headers, '/redfish/v1/Systems/');
    const managerPath = await resolveMemberPath(url, headers, '/redfish/v1/Managers/');

    const system = await getJson(url, systemPath, headers);
    const manager = await getJson(url, managerPath, headers);

    // The iLO's own dedicated management NIC -- the address this plugin is
    // literally talking to -- distinct from the host OS's NICs below. Best
    // effort: an iLO with DHCP-only NIC config or a locked-down account may
    // not expose this collection.
    let iloIp = null, iloMac = null;
    try {
      const nicPath = await resolveMemberPath(url, headers, `${managerPath}EthernetInterfaces/`);
      const nic = await getJson(url, nicPath, headers);
      iloMac = nic.MACAddress || null;
      const v4 = (nic.IPv4Addresses || [])[0];
      iloIp = (v4 && v4.Address) || null;
    } catch (e) { /* covered by validate(); a partial discover still reports what it has */ }

    // The host OS's own NICs (as the server's BIOS/BMC sees them, whether or
    // not the OS is even running) -- kept separate from the iLO's own NIC
    // above so a `docker`/`proxmox`/theta-agent discovery of the SAME
    // physical box has real MACs to reconcile against.
    const interfaces = [];
    try {
      const listPath = `${systemPath}EthernetInterfaces/`;
      const list = await getJson(url, listPath, headers);
      for (const member of (list.Members || [])) {
        const nic = await getJson(url, member['@odata.id'], headers).catch(() => null);
        if (!nic) continue;
        const v4 = (nic.IPv4Addresses || [])[0];
        interfaces.push({
          mac: nic.MACAddress || null,
          ip: (v4 && v4.Address) || null,
          ips: v4 ? [v4.Address] : [],
          name: nic.Name || nic.Id || null
        });
      }
    } catch (e) { /* not every iLO/host config exposes this */ }

    const serial = system.SerialNumber || null;
    const slug = `ilo-${(serial || system.HostName || url).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    const health = system.Status && system.Status.Health;
    const primaryIface = interfaces.find(i => i.ip) || null;

    const resources = [{
      kind: 'host',
      name: system.HostName || system.Model || `iLO (${url.replace(/^https?:\/\//, '')})`,
      slug,
      metadata: {
        subType: 'ilo',
        address: url,
        // The iLO management NIC is what "reaches" this resource -- the
        // reconciler's ip/macAddress-based matching should key off that, not
        // an OS NIC that may belong to an already-discovered `host` row for
        // the same box via theta-agent/proxmox/docker.
        ip: iloIp,
        macAddress: iloMac,
        model: system.Model || null,
        manufacturer: system.Manufacturer || null,
        serial,
        biosVersion: system.BiosVersion || null,
        managerModel: manager.Model || null,
        firmware: manager.FirmwareVersion || null,
        health: health || null,
        powerState: system.PowerState || null,
        cpuCount: (system.ProcessorSummary && system.ProcessorSummary.Count) || null,
        cpuModel: (system.ProcessorSummary && system.ProcessorSummary.Model) || null,
        memoryGiB: (system.MemorySummary && system.MemorySummary.TotalSystemMemoryGiB) || null,
        // The host's own NICs, recorded for the reconciler to match against
        // (see the ip/macAddress comment above for why the iLO's own NIC is
        // what's used for THIS resource's primary address instead).
        interfaces,
        hostIp: primaryIface ? primaryIface.ip : null,
        hostMac: primaryIface ? primaryIface.mac : null,
        sourceId: serial || url,
        isProduction: system.PowerState === 'On'
      }
    }];

    return { resources, edges: [] };
  },

  // The generalized plugin contract calls `run`; the discovery plugins keep
  // `discover` as their implementation name for back-compat, and `run` is
  // just an alias. Referenced via module.exports (not `this`) so it survives
  // being detached and called as a bare function reference.
  run: async (config) => module.exports.discover(config)
};
