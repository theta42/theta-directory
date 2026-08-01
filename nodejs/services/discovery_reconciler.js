const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { WebhookEmitter } = require('./webhook_emitter');
const crypto = require('crypto');

class DiscoveryReconciler {
  static async reconcile(sourceName, payload) {
    const { resources = [], edges = [] } = payload;
    let newDevices = 0;

    for (const res of resources) {
      if (!res.metadata) res.metadata = {};
      
      let existing = null;
      
      // Attempt matching by MAC if available
      if (res.metadata.interfaces && res.metadata.interfaces.length > 0) {
        const macs = res.metadata.interfaces.map(i => i.mac).filter(m => !!m);
        if (macs.length > 0) {
          const allRes = await Resource.list();
          existing = allRes.find(r => 
            r.metadata && r.metadata.interfaces && 
            r.metadata.interfaces.some(i => macs.includes(i.mac))
          );
        }
      }
      
      // Fallback matching by IP if no MAC match (weaker)
      let ipsToMatch = [];
      if (res.metadata.interfaces) {
        ipsToMatch = res.metadata.interfaces.map(i => i.ip).filter(i => !!i);
      }
      if (res.metadata.address) {
        res.metadata.address.split(',').forEach(a => ipsToMatch.push(a.trim()));
      }
      
      if (!existing && ipsToMatch.length > 0) {
        const allRes = await Resource.list();
        existing = allRes.find(r => {
          if (!r.metadata) return false;
          if (r.metadata.address) {
            const addrs = r.metadata.address.split(',').map(a => a.trim());
            if (addrs.some(a => ipsToMatch.includes(a))) return true;
          }
          if (r.metadata.interfaces && r.metadata.interfaces.some(i => ipsToMatch.includes(i.ip))) return true;
          return false;
        });
      }
      
      // Fallback matching by Slug or Name
      if (!existing && (res.slug || res.name)) {
        const allRes = await Resource.list();
        existing = allRes.find(r => 
          (res.slug && r.slug === res.slug) || 
          (res.name && r.name && r.name.toLowerCase() === res.name.toLowerCase())
        );
      }

      if (existing) {
        // Merge metadata
        const mergedMeta = { ...existing.metadata, ...res.metadata };
        
        // Merge interfaces cleanly
        if (res.metadata.interfaces) {
          const existingIntfs = existing.metadata.interfaces || [];
          const newIntfs = res.metadata.interfaces;
          // Simple union based on mac or ip
          for (const ni of newIntfs) {
            const idx = existingIntfs.findIndex(ei => (ni.mac && ei.mac === ni.mac) || (ni.ip && ei.ip === ni.ip));
            if (idx >= 0) existingIntfs[idx] = { ...existingIntfs[idx], ...ni };
            else existingIntfs.push(ni);
          }
          mergedMeta.interfaces = existingIntfs;
        }

        // Add discovery source
        const sources = new Set(mergedMeta.discovery_sources || []);
        sources.add(sourceName);
        mergedMeta.discovery_sources = [...sources];
        
        mergedMeta.last_seen = Date.now();
        
        await existing.update({
          name: res.name || existing.name,
          description: res.description || existing.description,
          metadata: mergedMeta,
          updated_on: Math.floor(Date.now() / 1000)
        });
      } else {
        // Create new
        const sources = [sourceName];
        res.metadata.discovery_sources = sources;
        res.metadata.last_seen = Date.now();
        
        const slug = res.slug || `${res.kind}-${crypto.randomBytes(4).toString('hex')}`;
        
        const created = await Resource.create({
          id: crypto.randomUUID(),
          kind: res.kind || 'unmanaged_device',
          name: res.name || slug,
          slug: slug,
          metadata: res.metadata,
          created_on: Math.floor(Date.now() / 1000)
        });
        
        newDevices++;
        WebhookEmitter.emit('discovery.new_device', created.toJSON());
      }
    }
    
    // We can handle edges similarly if needed, but for simplicity we assume edges are managed elsewhere 
    // or we just trust the plugins to give us explicit parent-child mappings by slug.
    
    if (newDevices > 0) {
      console.log(`[DiscoveryReconciler] Source ${sourceName} discovered ${newDevices} new devices.`);
    }
  }

  static async garbageCollect(staleMs = 7 * 24 * 60 * 60 * 1000) {
    const allRes = await Resource.list();
    const cutoff = Date.now() - staleMs;
    let archived = 0;

    for (const res of allRes) {
      const meta = res.metadata || {};
      const sources = meta.discovery_sources || [];
      // Only garbage collect things that are exclusively auto-discovered
      if (sources.length > 0 && !sources.includes('manual')) {
        if (meta.last_seen && meta.last_seen < cutoff && meta.lifecycle_state !== 'archived') {
          meta.lifecycle_state = 'archived';
          await res.update({ metadata: meta, updated_on: Math.floor(Date.now() / 1000) });
          archived++;
          WebhookEmitter.emit('discovery.device_archived', res.toJSON());
        }
      }
    }
    if (archived > 0) console.log(`[DiscoveryReconciler] Garbage collected ${archived} stale devices.`);
  }
}

module.exports = { DiscoveryReconciler };
