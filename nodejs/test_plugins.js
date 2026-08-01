const proxmox = require('./plugins/discovery/proxmox');
const unifi = require('./plugins/discovery/unifi');

async function test() {
  console.log("=== Running Proxmox Plugin ===");
  try {
    const pveData = await proxmox.discover({
      url: 'https://dl380-0.internal.718it.biz:8006',
      tokenId: 'root@pam!agy',
      tokenSecret: '1e7c0e31-6767-4295-bcda-d7acf5df1d9a'
    });
    console.log(`Found ${pveData.resources.length} resources and ${pveData.edges.length} edges.`);
    console.log("Sample resource:");
    console.log(JSON.stringify(pveData.resources[0], null, 2));
    console.log("Sample edge:");
    console.log(JSON.stringify(pveData.edges[0], null, 2));
  } catch (e) {
    console.error("Proxmox failed:", e.message);
  }

  console.log("\n=== Running Unifi Plugin ===");
  try {
    const unifiData = await unifi.discover({
      url: 'https://unifi.718it.biz',
      user: 'agy',
      password: 'MyPassword!23'
    });
    console.log(`Found ${unifiData.resources.length} resources and ${unifiData.edges.length} edges.`);
    console.log("Sample resource:");
    console.log(JSON.stringify(unifiData.resources.find(r => r.kind === 'network_device'), null, 2));
  } catch (e) {
    console.error("Unifi failed:", e.message);
  }
}

test();
