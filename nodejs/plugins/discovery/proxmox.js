const fetch = require('node-fetch');
const https = require('https');

// Custom agent to bypass self-signed certs typical in Proxmox
const agent = new https.Agent({
  rejectUnauthorized: false
});

// Accumulates a guest's NICs, keyed by MAC, merging what several Proxmox
// endpoints each know a piece of: the guest agent knows MAC+IP together, the
// VM/LXC config knows the MAC even while the guest is stopped, and the LXC
// interfaces endpoint knows the DHCP-assigned IP. Keying by MAC is what keeps
// the pairing honest -- the previous code collected MACs and IPs into two flat
// lists and zipped them by index, which mismatched them on any multi-NIC guest.
class Interfaces {
  constructor() { this.byMac = new Map(); this.anonymous = []; }

  // Interfaces that belong to something running INSIDE the guest -- container
  // engines, overlay networks, VPNs -- rather than to the guest itself. A
  // Home Assistant VM reported 16 of these (docker0, hassio, 14x veth*)
  // alongside its one real NIC, which is noise in the directory and, worse,
  // gives the reconciler a pile of 172.x addresses to match unrelated hosts on.
  // Only applied to guests; a hypervisor's own bridges are how you reach it.
  static VIRTUAL_IFACE_RE = /^(lo|docker\d*|hassio|veth|br-|virbr|tap|fwbr|fwln|fwpr|cni|flannel|cali|kube|weave|zt|tailscale|wg|tun|utun)/i;

  static isVirtualName(name) {
    return !!name && Interfaces.VIRTUAL_IFACE_RE.test(name);
  }

  // A udev "predictable" name of the form enx<12 hex> encodes the MAC. It is
  // the only place the Proxmox node network API exposes a physical NIC's MAC
  // (/nodes/{node}/network carries no hwaddr field at all), so parse it out
  // rather than leaving every hypervisor MAC-less.
  static macFromIfaceName(name) {
    const m = /^enx([0-9a-f]{12})$/i.exec(name || '');
    if (!m) return null;
    return m[1].toLowerCase().match(/.{2}/g).join(':');
  }

  static normalizeMac(mac) {
    const m = (mac || '').toLowerCase().trim();
    if (!/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m)) return null;
    if (m === '00:00:00:00:00:00') return null;
    return m;
  }

  // `ips` are the addresses observed on this one NIC (may be empty for a
  // stopped guest, where only the MAC is known).
  add(mac, ips, name) {
    const key = Interfaces.normalizeMac(mac);
    const addrs = (ips || []).filter(Boolean);
    if (!key) {
      // An IP with no usable MAC is still worth keeping; a NIC with neither is not.
      if (addrs.length) this.anonymous.push({ mac: null, ip: addrs[0], ips: addrs, name: name || null });
      return;
    }
    const existing = this.byMac.get(key);
    if (existing) {
      for (const ip of addrs) if (!existing.ips.includes(ip)) existing.ips.push(ip);
      existing.ip = existing.ips[0] || null;
      if (!existing.name && name) existing.name = name;
      return;
    }
    this.byMac.set(key, { mac: key, ip: addrs[0] || null, ips: addrs, name: name || null });
  }

  toArray() { return [...this.byMac.values(), ...this.anonymous]; }

  // The address/MAC the directory shows in its single-value columns, and what
  // the reconciler matches on. Prefer a NIC that actually has an address.
  primaryIp() {
    const withIp = this.toArray().find(i => i.ip);
    return withIp ? withIp.ip : null;
  }

  primaryMac() {
    const withIp = this.toArray().find(i => i.ip && i.mac);
    if (withIp) return withIp.mac;
    const first = this.toArray().find(i => i.mac);
    return first ? first.mac : null;
  }
}

module.exports = {
  // Plugin manifest — see nodejs/services/plugin_registry.js. `configSchema`
  // drives the admin UI form and validation; fields flagged `secret:true` are
  // stored in OpenBao (secret/plugins/<instance-id>/conf), never in the DB.
  type: 'proxmox',
  category: 'discovery',
  name: 'Proxmox VE',
  description: 'Discover VMs, containers, and hypervisor nodes from a Proxmox VE API endpoint.',
  configSchema: [
    { key: 'url',         label: 'API URL',      type: 'url',      required: true, placeholder: 'https://pve.example:8006' },
    { key: 'tokenId',     label: 'Token ID',     type: 'text',     required: true, placeholder: 'user@pam!token' },
    { key: 'tokenSecret', label: 'Token Secret', type: 'password', required: true, secret: true }
  ],

  // "Test" button in the UI: hit the unauthenticated version endpoint with the
  // API token to confirm the URL + token are valid before scheduling runs.
  validate: async (config) => {
    const { url, tokenId, tokenSecret } = config;
    if (!url || !tokenId || !tokenSecret) return { ok: false, error: 'Missing url, tokenId, or tokenSecret' };
    try {
      const res = await fetch(`${url}/api2/json/version`, { headers: { 'Authorization': `PVEAPIToken=${tokenId}=${tokenSecret}` }, agent });
      if (!res.ok) return { ok: false, error: `Proxmox API rejected the token (${res.status})` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  discover: async (config) => {
    let { url, tokenId, tokenSecret } = config;
    if (!url || !tokenId || !tokenSecret) {
      throw new Error("Missing Proxmox config");
    }

    const headers = {
      'Authorization': `PVEAPIToken=${tokenId}=${tokenSecret}`
    };
    
    // Ensure URL has no trailing slash
    url = url.endsWith('/') ? url.slice(0, -1) : url;

    const resources = [];
    const edges = [];

    // 0. The Proxmox endpoint itself. Without it a multi-node cluster produces
    // several unrelated roots in the Directory tree and nothing says where any
    // of them came from. Every node discovered below is parented to this, so
    // one endpoint == one subtree.
    const endpointHost = (() => {
      try { return new URL(url).hostname; } catch (e) { return url.replace(/^https?:\/\//, '').split('/')[0]; }
    })();
    const clusterName = await (async () => {
      // /cluster/status names the cluster when one exists; a standalone node
      // has no cluster entry, in which case the endpoint hostname is the name.
      try {
        const res = await fetch(`${url}/api2/json/cluster/status`, { headers, agent });
        if (!res.ok) return null;
        const entry = ((await res.json()).data || []).find(d => d.type === 'cluster');
        return entry ? entry.name : null;
      } catch (e) { return null; }
    })();

    const endpointSlug = `pve-${endpointHost.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
    resources.push({
      kind: 'host',
      name: clusterName || `Proxmox (${endpointHost})`,
      slug: endpointSlug,
      metadata: {
        subType: 'proxmox',
        address: url,
        os: 'Proxmox VE',
        isProduction: true,
        sourceId: url,
        // Deliberately NO `ip`/`interfaces`: this resource stands for the
        // cluster (the API endpoint), not for a machine. Giving it the address
        // it is reached at made the reconciler match it to the very node that
        // answers on that address -- the endpoint and the node collapsed into
        // one row, which then became its own parent. The cluster is identified
        // by slug + sourceId instead, which nothing else can collide with.
        interfaces: []
      }
    });

    // 1. Get Nodes
    const resNodes = await fetch(`${url}/api2/json/nodes`, { headers, agent });
    if(!resNodes.ok) {
        const errText = await resNodes.text();
        throw new Error(`Proxmox API error on nodes: ${resNodes.status} ${errText}`);
    }
    const nodes = (await resNodes.json()).data;

    for (const node of nodes) {
      // An offline node is still a real hypervisor that belongs in the
      // directory -- skipping it entirely used to make it look decommissioned
      // and let the reconciler's garbage collector archive it after a week of
      // downtime. Record it, mark it down, and skip only the guest enumeration
      // (which needs the node to answer).
      const online = node.status === 'online';

      const nodeSlug = `pve-node-${node.node}`;

      // A hypervisor with no address is not actionable. Read its bridges/NICs
      // so the node lands in the directory reachable and MAC-identified like
      // any other host. Unlike a guest, a node's bridges are kept: vmbrN is
      // normally the address you actually reach the hypervisor on.
      const nodeIfaces = new Interfaces();
      try {
        const netRes = online
          ? await fetch(`${url}/api2/json/nodes/${node.node}/network`, { headers, agent })
          : { ok: false };
        if (netRes.ok) {
          const ifaceList = (await netRes.json()).data || [];
          for (const iface of ifaceList) {
            if (iface.iface === 'lo') continue;
            const ip = iface.address || iface.cidr;
            // This endpoint has no hwaddr field, so the MAC has to be recovered
            // from a predictable interface name -- either this interface's own
            // or, for a bridge, one of the physical ports beneath it.
            let mac = Interfaces.macFromIfaceName(iface.iface);
            if (!mac) {
              for (const alt of (iface.altnames || [])) {
                mac = Interfaces.macFromIfaceName(alt);
                if (mac) break;
              }
            }
            if (!mac && iface.bridge_ports) {
              for (const port of String(iface.bridge_ports).split(/\s+/).filter(Boolean)) {
                mac = Interfaces.macFromIfaceName(port);
                if (mac) break;
                // The port may itself only carry the MAC in an altname.
                const portDef = ifaceList.find(i => i.iface === port);
                for (const alt of ((portDef && portDef.altnames) || [])) {
                  mac = Interfaces.macFromIfaceName(alt);
                  if (mac) break;
                }
                if (mac) break;
              }
            }
            nodeIfaces.add(mac || iface.hwaddr, ip ? [String(ip).split('/')[0]] : [], iface.iface);
          }
        }
      } catch (e) {}

      resources.push({
        kind: 'host',
        name: node.node,
        slug: nodeSlug,
        metadata: {
          subType: 'hypervisor',
          os: 'Proxmox VE',
          isProduction: true,
          status: node.status,
          sourceId: `${node.node}`,
          node: node.node,
          interfaces: nodeIfaces.toArray(),
          macAddress: nodeIfaces.primaryMac(),
          ip: nodeIfaces.primaryIp()
        }
      });
      edges.push({ parentSlug: endpointSlug, childSlug: nodeSlug, relation: 'hosts' });

      // Everything below asks the node itself; an offline node answers none of
      // it, and its guests are already recorded from previous runs.
      if (!online) continue;

      // 2. Get VMs for this node
      const resVms = await fetch(`${url}/api2/json/nodes/${node.node}/qemu`, { headers, agent });
      const vms = resVms.ok ? ((await resVms.json()).data || []) : [];

      for (const vm of vms) {
        const vmSlug = `vm-${vm.vmid}`;
        const isTemplate = vm.template === 1;
        
        const ifaces = new Interfaces();

        // Enrich from QEMU guest agent if running. The agent is the only source
        // that knows which IP sits on which NIC, so pair them here rather than
        // accumulating two flat lists (zipping those by index attributed IPs to
        // the wrong MAC on any guest with more than one NIC).
        if (vm.status === 'running') {
            try {
                const agentRes = await fetch(`${url}/api2/json/nodes/${node.node}/qemu/${vm.vmid}/agent/network-get-interfaces`, { headers, agent });
                if (agentRes.ok) {
                    const agentData = (await agentRes.json()).data;
                    if (agentData && agentData.result) {
                        for (const iface of agentData.result) {
                            // Docker bridges, veth pairs and VPN tunnels are the
                            // guest's own plumbing, not NICs of the guest.
                            if (Interfaces.isVirtualName(iface.name)) continue;
                            const ips = (iface['ip-addresses'] || [])
                                .filter(ip => ip['ip-address-type'] === 'ipv4' && ip['ip-address'] !== '127.0.0.1')
                                .map(ip => ip['ip-address']);
                            ifaces.add(iface['hardware-address'], ips, iface.name);
                        }
                    }
                }
            } catch(e) {}
        }

        // Enrich from VM config: the MAC is declared there whether or not the
        // guest agent answered, so a stopped VM still gets a stable identity.
        try {
            const configRes = await fetch(`${url}/api2/json/nodes/${node.node}/qemu/${vm.vmid}/config`, { headers, agent });
            if (configRes.ok) {
                const confData = (await configRes.json()).data;
                for (let i = 0; i < 10; i++) {
                    if (confData[`net${i}`]) {
                        const m = confData[`net${i}`].match(/(?:virtio|e1000e?|rtl8139|vmxnet3)=([0-9a-fA-F:]{17})/);
                        if(m) ifaces.add(m[1], [], `net${i}`);
                    }
                }
            }
        } catch(e) {}

        const interfaces = ifaces.toArray();

        resources.push({
          kind: isTemplate ? 'template' : 'host',
          name: vm.name || `VM ${vm.vmid}`,
          slug: vmSlug,
          metadata: {
            subType: isTemplate ? 'template' : 'vm',
            vmid: vm.vmid,
            // The Proxmox-side identity, so a resource can be traced back to the
            // exact guest on the exact node it was discovered from.
            sourceId: `${node.node}/qemu/${vm.vmid}`,
            node: node.node,
            isProduction: vm.status === 'running',
            interfaces,
            macAddress: ifaces.primaryMac(),
            ip: ifaces.primaryIp()
          }
        });
        edges.push({ parentSlug: nodeSlug, childSlug: vmSlug, relation: 'hosts' });
      }

      // 3. Get LXCs for this node
      const resLxcs = await fetch(`${url}/api2/json/nodes/${node.node}/lxc`, { headers, agent });
      const lxcs = resLxcs.ok ? ((await resLxcs.json()).data || []) : [];

      for (const lxc of lxcs) {
        const lxcSlug = `lxc-${lxc.vmid}`;
        const isTemplate = lxc.template === 1;
        
        const ifaces = new Interfaces();

        // Enrich from LXC config. Each netN line carries its own hwaddr and ip,
        // so read them off the same line instead of into parallel lists.
        try {
            const configRes = await fetch(`${url}/api2/json/nodes/${node.node}/lxc/${lxc.vmid}/config`, { headers, agent });
            if (configRes.ok) {
                const confData = (await configRes.json()).data;
                for (let i = 0; i < 10; i++) {
                    const line = confData[`net${i}`];
                    if (!line) continue;
                    const hwMatch = line.match(/hwaddr=([0-9a-fA-F:]{17})/);
                    // `ip=` is either a CIDR address or the literal `dhcp`/`manual`.
                    const ipMatch = line.match(/\bip=(\d+\.\d+\.\d+\.\d+)/);
                    const nameMatch = line.match(/\bname=([^,]+)/);
                    if (hwMatch || ipMatch) {
                        ifaces.add(hwMatch && hwMatch[1], ipMatch ? [ipMatch[1]] : [], nameMatch ? nameMatch[1] : `net${i}`);
                    }
                }
            }
        } catch(e) {}

        // A DHCP-configured container has no IP in its config. Ask the running
        // container's interface list so it lands in the directory addressable
        // instead of as an IP-less row.
        if (lxc.status === 'running' && !ifaces.primaryIp()) {
            try {
                const ifRes = await fetch(`${url}/api2/json/nodes/${node.node}/lxc/${lxc.vmid}/interfaces`, { headers, agent });
                if (ifRes.ok) {
                    for (const iface of ((await ifRes.json()).data || [])) {
                        if (Interfaces.isVirtualName(iface.name)) continue;
                        const ip = (iface.inet || '').split('/')[0];
                        ifaces.add(iface.hwaddr, ip ? [ip] : [], iface.name);
                    }
                }
            } catch(e) {}
        }

        const interfaces = ifaces.toArray();

        resources.push({
          kind: isTemplate ? 'template' : 'host',
          name: lxc.name || `LXC ${lxc.vmid}`,
          slug: lxcSlug,
          metadata: {
            subType: isTemplate ? 'template' : 'lxc',
            vmid: lxc.vmid,
            sourceId: `${node.node}/lxc/${lxc.vmid}`,
            node: node.node,
            isProduction: lxc.status === 'running',
            interfaces,
            macAddress: ifaces.primaryMac(),
            ip: ifaces.primaryIp()
          }
        });
        edges.push({ parentSlug: nodeSlug, childSlug: lxcSlug, relation: 'hosts' });
      }
    }

    return { resources, edges };
  },

  // The generalized plugin contract calls `run`; the discovery plugins keep
  // `discover` as their implementation name for back-compat, and `run` is just
  // an alias. Referenced via module.exports (not `this`) so it survives being
  // detached and called as a bare function reference.
  run: async (config) => module.exports.discover(config),

  // Exported for unit tests only -- not part of the plugin contract.
  _Interfaces: Interfaces
};
