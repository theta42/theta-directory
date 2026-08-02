const fetch = require('node-fetch');
const https = require('https');

// Custom agent to bypass self-signed certs typical in Proxmox
const agent = new https.Agent({
  rejectUnauthorized: false
});

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
    const { url, tokenId, tokenSecret } = config;
    if (!url || !tokenId || !tokenSecret) {
      throw new Error("Missing Proxmox config");
    }

    const headers = {
      'Authorization': `PVEAPIToken=${tokenId}=${tokenSecret}`
    };
    
    // Ensure URL has no trailing slash
    url = url.replace(/\\/+$/, '');

    const resources = [];
    const edges = [];

    // 1. Get Nodes
    const resNodes = await fetch(`${url}/api2/json/nodes`, { headers, agent });
    if(!resNodes.ok) {
        const errText = await resNodes.text();
        throw new Error(`Proxmox API error on nodes: ${resNodes.status} ${errText}`);
    }
    const nodes = (await resNodes.json()).data;

    for (const node of nodes) {
      if (node.status !== 'online') continue;
      
      const nodeSlug = `pve-node-${node.node}`;
      resources.push({
        kind: 'host',
        name: node.node,
        slug: nodeSlug,
        metadata: {
          subType: 'hypervisor',
          os: 'Proxmox VE',
          isProduction: true,
          interfaces: [] 
        }
      });

      // 2. Get VMs for this node
      const resVms = await fetch(`${url}/api2/json/nodes/${node.node}/qemu`, { headers, agent });
      const vms = resVms.ok ? ((await resVms.json()).data || []) : [];

      for (const vm of vms) {
        const vmSlug = `vm-${vm.vmid}`;
        const isTemplate = vm.template === 1;
        
        let ips = [];
        let macs = [];
        
        // Enrich from QEMU guest agent if running
        if (vm.status === 'running') {
            try {
                const agentRes = await fetch(`${url}/api2/json/nodes/${node.node}/qemu/${vm.vmid}/agent/network-get-interfaces`, { headers, agent });
                if (agentRes.ok) {
                    const agentData = (await agentRes.json()).data;
                    if (agentData && agentData.result) {
                        for (const iface of agentData.result) {
                            if (iface['hardware-address'] && iface['hardware-address'] !== '00:00:00:00:00:00') macs.push(iface['hardware-address']);
                            if (iface['ip-addresses']) {
                                for (const ip of iface['ip-addresses']) {
                                    if (ip['ip-address-type'] === 'ipv4' && ip['ip-address'] !== '127.0.0.1') {
                                        ips.push(ip['ip-address']);
                                    }
                                }
                            }
                        }
                    }
                }
            } catch(e) {}
        }
        
        // Enrich from VM config to at least get MAC if agent failed/stopped
        try {
            const configRes = await fetch(`${url}/api2/json/nodes/${node.node}/qemu/${vm.vmid}/config`, { headers, agent });
            if (configRes.ok) {
                const confData = (await configRes.json()).data;
                for (let i = 0; i < 10; i++) {
                    if (confData[`net${i}`]) {
                        const m = confData[`net${i}`].match(/(?:virtio|e1000|rtl8139|vmxnet3)=([0-9a-fA-F:]+)/);
                        if(m) macs.push(m[1].toLowerCase());
                    }
                }
            }
        } catch(e) {}

        const interfaces = [...new Set(macs)].map((mac, i) => ({ mac, ip: ips[i] || null }));

        resources.push({
          kind: isTemplate ? 'template' : 'host',
          name: vm.name || `VM ${vm.vmid}`,
          slug: vmSlug,
          metadata: {
            subType: isTemplate ? 'template' : 'vm',
            vmid: vm.vmid,
            isProduction: vm.status === 'running',
            interfaces,
            ip: ips[0] || null
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
        
        let ips = [];
        let macs = [];
        
        // Enrich from LXC config
        try {
            const configRes = await fetch(`${url}/api2/json/nodes/${node.node}/lxc/${lxc.vmid}/config`, { headers, agent });
            if (configRes.ok) {
                const confData = (await configRes.json()).data;
                for (let i = 0; i < 10; i++) {
                    if (confData[`net${i}`]) {
                        const hwMatch = confData[`net${i}`].match(/hwaddr=([0-9a-fA-F:]+)/);
                        const ipMatch = confData[`net${i}`].match(/ip=([0-9\.]+)/); // Ignores dhcp
                        if(hwMatch) macs.push(hwMatch[1].toLowerCase());
                        if(ipMatch) ips.push(ipMatch[1]);
                    }
                }
            }
        } catch(e) {}

        const interfaces = [...new Set(macs)].map((mac, i) => ({ mac, ip: ips[i] || null }));

        resources.push({
          kind: isTemplate ? 'template' : 'host',
          name: lxc.name || `LXC ${lxc.vmid}`,
          slug: lxcSlug,
          metadata: {
            subType: isTemplate ? 'template' : 'lxc',
            vmid: lxc.vmid,
            isProduction: lxc.status === 'running',
            interfaces,
            ip: ips[0] || null
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
  run: async (config) => module.exports.discover(config)
};
