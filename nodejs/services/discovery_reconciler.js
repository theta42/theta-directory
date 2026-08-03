const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { WebhookEmitter } = require('./webhook_emitter');
const crypto = require('crypto');

class DiscoveryReconciler {
  static async reconcile(sourceName, payload) {
    const { resources = [], edges = [] } = payload;
    let newDevices = 0;

    for (const res of resources) {
      if (!res.metadata) res.metadata = {};
      res._originalSlug = res.slug; // Keep track for edge mapping
      
      let existing = null;
      const normalizeMac = (m) => (m || '').toLowerCase().replace(/[^a-f0-9]/g, '');
      const normalizeHost = (h) => (h || '').toLowerCase().split('.')[0].trim();

      const allRes = await Resource.list();

      // 1. Attempt matching by MAC (highest precision)
      if (res.metadata.interfaces && res.metadata.interfaces.length > 0) {
        const macs = res.metadata.interfaces.map(i => normalizeMac(i.mac)).filter(m => m.length === 12);
        if (macs.length > 0) {
          existing = allRes.find(r => 
            r.metadata && (
              (r.metadata.macAddress && macs.includes(normalizeMac(r.metadata.macAddress))) ||
              (r.metadata.interfaces && r.metadata.interfaces.some(i => macs.includes(normalizeMac(i.mac))))
            )
          );
        }
      }

      // 2. Fallback matching by IP address
      let ipsToMatch = [];
      if (res.metadata.interfaces) {
        ipsToMatch = res.metadata.interfaces.map(i => i.ip).filter(i => !!i);
      }
      if (res.metadata.ip) ipsToMatch.push(res.metadata.ip);
      if (res.metadata.address) {
        res.metadata.address.split(',').forEach(a => ipsToMatch.push(a.trim()));
      }
      ipsToMatch = [...new Set(ipsToMatch.filter(Boolean))];

      if (!existing && ipsToMatch.length > 0) {
        existing = allRes.find(r => {
          if (!r.metadata) return false;
          if (r.metadata.ip && ipsToMatch.includes(r.metadata.ip)) return true;
          if (r.metadata.address) {
            const addrs = r.metadata.address.split(',').map(a => a.trim());
            if (addrs.some(a => ipsToMatch.includes(a))) return true;
          }
          if (r.metadata.interfaces && r.metadata.interfaces.some(i => ipsToMatch.includes(i.ip))) return true;
          return false;
        });
      }

      // 3. Fallback matching by Slug, Name, or Base Hostname
      if (!existing && (res.slug || res.name)) {
        const inputName = normalizeHost(res.name || res.slug);
        existing = allRes.find(r => {
          if (res.slug && r.slug === res.slug) return true;
          if (res.name && r.name && r.name.toLowerCase() === res.name.toLowerCase()) return true;
          if (inputName && r.name && normalizeHost(r.name) === inputName) return true;
          if (inputName && r.slug && normalizeHost(r.slug) === inputName) return true;
          return false;
        });
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
            const idx = existingIntfs.findIndex(ei => 
              (ni.mac && ei.mac && ei.mac.toLowerCase() === ni.mac.toLowerCase()) || 
              (ni.ip && ei.ip && ei.ip === ni.ip)
            );
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
        
        const isIp = (str) => /^(?:[0-9]{1,3}\\.){3}[0-9]{1,3}$/.test(str || '');
        let bestName = existing.name;
        if (res.name && (!bestName || isIp(bestName) || res.name.length > bestName.length && !isIp(res.name))) {
          bestName = res.name;
        }

        await existing.update({
          name: bestName,
          description: res.description || existing.description,
          metadata: mergedMeta,
          updated_on: Math.floor(Date.now() / 1000)
        });
        res._actualId = existing.id;
      } else {
        // Create new
        const sources = new Set([sourceName]);
        res.metadata.discovery_sources = [...sources];
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
        res._actualId = created.id; // Map original slug to actual ID
        WebhookEmitter.emit('discovery.new_device', created.toJSON());
      }
    }
    
    // Now process edges
    const allRes = await Resource.list();
    const existingEdges = await ResourceEdge.list();
    
    for (const edge of edges) {
      // Find parent ID. It might be in the current payload (mapped to _actualId) or in DB by slug
      let parentId = null;
      const parentResInPayload = resources.find(r => r._originalSlug === edge.parentSlug);
      if (parentResInPayload && parentResInPayload._actualId) {
        parentId = parentResInPayload._actualId;
      } else {
        const parentResInDb = allRes.find(r => r.slug === edge.parentSlug);
        if (parentResInDb) parentId = parentResInDb.id;
      }
      
      // Find child ID
      let childId = null;
      const childResInPayload = resources.find(r => r._originalSlug === edge.childSlug);
      if (childResInPayload && childResInPayload._actualId) {
        childId = childResInPayload._actualId;
      } else {
        const childResInDb = allRes.find(r => r.slug === edge.childSlug);
        if (childResInDb) childId = childResInDb.id;
      }
      
      if (parentId && childId) {
        const edgeExists = existingEdges.find(e => e.parentId === parentId && e.childId === childId && e.relation === edge.relation);
        if (!edgeExists) {
          await ResourceEdge.create({
            id: crypto.randomUUID(),
            parentId,
            childId,
            relation: edge.relation
          });
        }
      }
    }
    
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
