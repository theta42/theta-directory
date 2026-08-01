const { Resource } = require('./models/resource');
const { initORM } = require('./models/index');

async function run() {
  await initORM();
  const all = await Resource.list();
  console.log(`Found ${all.length} resources`);
  
  const byIp = {};
  const byName = {};
  
  for (const r of all) {
    if (!r.metadata) r.metadata = {};
    
    // gather IPs
    const ips = new Set();
    if (r.metadata.address) ips.add(r.metadata.address);
    if (r.metadata.interfaces) {
      r.metadata.interfaces.forEach(i => { if (i.ip) ips.add(i.ip); });
    }
    
    for (const ip of ips) {
      if (!byIp[ip]) byIp[ip] = [];
      byIp[ip].push(r);
    }
    
    const nameLower = (r.name || '').toLowerCase();
    if (nameLower) {
      if (!byName[nameLower]) byName[nameLower] = [];
      byName[nameLower].push(r);
    }
  }

  // Find duplicates
  const toDelete = new Set();
  
  for (const ip in byIp) {
    if (byIp[ip].length > 1) {
      // Sort so managed/older is kept
      const group = byIp[ip].sort((a, b) => {
        const aM = a.metadata?.managed ? 1 : 0;
        const bM = b.metadata?.managed ? 1 : 0;
        if (aM !== bM) return bM - aM;
        return a.created_on - b.created_on;
      });
      
      const primary = group[0];
      for (let i = 1; i < group.length; i++) {
        const sec = group[i];
        if (toDelete.has(sec.id) || toDelete.has(primary.id)) continue;
        console.log(`Merging ${sec.name} into ${primary.name} due to IP ${ip}`);
        
        // merge metadata
        const m1 = primary.metadata || {};
        const m2 = sec.metadata || {};
        
        const mergedMeta = { ...m2, ...m1 };
        
        // merge interfaces
        const intfs = [...(m1.interfaces||[]), ...(m2.interfaces||[])];
        const uniqIntfs = [];
        const seenIps = new Set();
        for (const intf of intfs) {
          if (intf.ip && seenIps.has(intf.ip)) continue;
          if (intf.ip) seenIps.add(intf.ip);
          uniqIntfs.push(intf);
        }
        mergedMeta.interfaces = uniqIntfs;
        
        const sources = new Set([...(m1.discovery_sources||[]), ...(m2.discovery_sources||[])]);
        mergedMeta.discovery_sources = [...sources];
        
        await primary.update({
          metadata: mergedMeta,
          description: primary.description || sec.description
        });
        
        toDelete.add(sec.id);
      }
    }
  }

  for (const name in byName) {
    if (byName[name].length > 1) {
      // Sort so managed/older is kept
      const group = byName[name].sort((a, b) => {
        const aM = a.metadata?.managed ? 1 : 0;
        const bM = b.metadata?.managed ? 1 : 0;
        if (aM !== bM) return bM - aM;
        return a.created_on - b.created_on;
      });
      
      const primary = group[0];
      for (let i = 1; i < group.length; i++) {
        const sec = group[i];
        if (toDelete.has(sec.id) || toDelete.has(primary.id)) continue;
        console.log(`Merging ${sec.name} into ${primary.name} due to name ${name}`);
        
        // merge metadata
        const m1 = primary.metadata || {};
        const m2 = sec.metadata || {};
        
        const mergedMeta = { ...m2, ...m1 };
        
        // merge interfaces
        const intfs = [...(m1.interfaces||[]), ...(m2.interfaces||[])];
        const uniqIntfs = [];
        const seenIps = new Set();
        for (const intf of intfs) {
          if (intf.ip && seenIps.has(intf.ip)) continue;
          if (intf.ip) seenIps.add(intf.ip);
          uniqIntfs.push(intf);
        }
        mergedMeta.interfaces = uniqIntfs;
        
        const sources = new Set([...(m1.discovery_sources||[]), ...(m2.discovery_sources||[])]);
        mergedMeta.discovery_sources = [...sources];
        
        await primary.update({
          metadata: mergedMeta,
          description: primary.description || sec.description
        });
        
        toDelete.add(sec.id);
      }
    }
  }

  // Delete merged items
  for (const id of toDelete) {
    console.log(`Deleting merged resource ${id}`);
    const r = all.find(r => r.id === id);
    if (r) await r.delete();
  }

  console.log(`Merged ${toDelete.size} items.`);
  process.exit(0);
}

run().catch(console.error);
