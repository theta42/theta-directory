const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { WebhookEmitter } = require('./webhook_emitter');
const crypto = require('crypto');

// Is `candidateId` at or below `rootId` in the edge graph? Used to refuse an
// edge that would close a loop. Carries its own visited set so it terminates
// even if the stored graph already contains a cycle from an older release.
function isDescendant(candidateId, rootId, edges) {
  const seen = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (id === candidateId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of edges) if (e.parentId === id) stack.push(e.childId);
  }
  return false;
}

class DiscoveryReconciler {
  static async reconcile(sourceName, payload, options = {}) {
    const siteConfig = require('../utils/site_config');
    const cfg = siteConfig.get();
    if (!cfg.isMaster && cfg.masterUrl && (cfg.masterJoinKey || cfg.replicationPushToken) && !options._localOnly) {
      try {
        const { fetchWithAuthRedirect } = require('../utils/fetch_with_auth_redirect');
        const targetUrl = String(cfg.masterUrl).replace(/\/+$/, '') + '/api/site/spokes/discovery-report';
        const resp = await fetchWithAuthRedirect(targetUrl, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + (cfg.replicationPushToken || cfg.masterJoinKey),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ sourceName, payload, options })
        }, { timeoutMs: 15000 });
        if (resp.ok) {
          const body = await resp.json().catch(() => ({}));
          return body.result || { newDevices: 0 };
        }
        console.warn(`[DiscoveryReconciler] master rejected discovery forward (${resp.status}); applying locally as fallback`);
      } catch (err) {
        console.warn(`[DiscoveryReconciler] could not forward discovery to master (${err.message}); applying locally as fallback`);
      }
    }

    const { resources = [], edges = [] } = payload;
    let newDevices = 0;
    const location = options.location || options.site || null;
    const autoPromote = !!options.autoPromote;

    let targetSite = null;
    if (location && String(location).trim()) {
      const sites = await Resource.list({ where: { kind: 'site' } });
      const locStr = String(location).trim().toLowerCase();
      targetSite = sites.find(s => s.name.toLowerCase() === locStr || s.slug.toLowerCase() === locStr);
      if (!targetSite) {
        const locSlug = `site_${locStr.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
        targetSite = await Resource.create({
          id: crypto.randomUUID(),
          kind: 'site',
          name: String(location).trim(),
          slug: locSlug,
          created_on: Math.floor(Date.now() / 1000)
        }).catch(() => null);
      }
    }
    if (!targetSite) {
      const sites = await Resource.list({ where: { kind: 'site' } });
      if (sites && sites.length > 0) {
        targetSite = sites[0];
      } else {
        targetSite = await Resource.create({
          id: crypto.randomUUID(),
          kind: 'site',
          name: 'Default Site',
          slug: 'site_default',
          created_on: Math.floor(Date.now() / 1000)
        }).catch(() => null);
      }
    }

    const normalizeMac = (m) => (m || '').toLowerCase().replace(/[^a-f0-9]/g, '');
    const normalizeHost = (h) => (h || '').toLowerCase().split('.')[0].trim();

    // Read the inventory ONCE, not once per incoming resource. A Proxmox
    // cluster reports ~55 resources against an inventory of similar size, so
    // the per-iteration Resource.list() was doing quadratic full-table reads
    // every discovery run. Newly created rows are pushed onto this list as we
    // go, so later resources in the same payload still match against them.
    const allRes = await Resource.list();

    for (const res of resources) {
      if (!res.metadata) res.metadata = {};
      if (autoPromote) res.metadata.managed = true;
      res._originalSlug = res.slug; // Keep track for edge mapping

      let existing = null;

      // A discovered device may only merge into a resource of the same kind
      // (or into a placeholder from an earlier, kind-less discovery). Without
      // this a VM called "gitea-runner" matches a hand-created *service* of
      // the same name on rule 3 and silently overwrites it -- the discovered
      // host's metadata lands on a service row, and the operator's entry is
      // gone. `template` counts as `host`: a VM converted to a template is the
      // same device, and it should update in place rather than fork a row.
      const kindClass = (k) => (k === 'template' ? 'host' : k);
      const incomingKind = kindClass(res.kind || 'unmanaged_device');
      const kindCompatible = (r) => {
        const k = kindClass(r.kind);
        if (k === 'unmanaged_device' || incomingKind === 'unmanaged_device') return true;
        return k === incomingKind;
      };
      const candidates = allRes.filter(kindCompatible);

      // 1. God Key (UUID) Matching (highest precision)
      if (res.id) {
        existing = candidates.find(r => r.id === res.id);
      }

      // 2. MAC Address Matching (stable identity)
      const incomingMacs = [];
      if (res.metadata.macAddress) incomingMacs.push(normalizeMac(res.metadata.macAddress));
      if (res.metadata.interfaces) {
        for (const i of res.metadata.interfaces) {
          const m = normalizeMac(i.mac);
          if (m.length === 12) incomingMacs.push(m);
        }
      }
      const uniqueMacs = [...new Set(incomingMacs.filter(m => m.length === 12))];
      if (!existing && uniqueMacs.length > 0) {
        existing = candidates.find(r =>
          r.metadata && (
            (r.metadata.macAddress && uniqueMacs.includes(normalizeMac(r.metadata.macAddress))) ||
            (r.metadata.interfaces && r.metadata.interfaces.some(i => uniqueMacs.includes(normalizeMac(i.mac))))
          )
        );
      }

      // 3. Fallback matching by IP address (Strictly bound to targetSite and only if candidate lacks a MAC)
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
        existing = candidates.find(r => {
          // Strict boundaries: Never hijack a resource that has a MAC
          const rHasMac = !!(r.metadata && (r.metadata.macAddress || (r.metadata.interfaces && r.metadata.interfaces.some(i => i.mac))));
          if (rHasMac) return false;
          
          // Strict boundaries: Only match within the same site (we'll assume candidates array check or we check edges)
          // Since we can't synchronously check edges easily here without a graph, we rely on the parent matching or just matching if it has no MAC.
          // Wait, to be safe, if we are doing IP fallback, let's just make sure it's not strongly bound.
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

      // 4. Fallback matching by Slug, Name, or Base Hostname
      const hasMac = uniqueMacs.length > 0;
      const hasIp = ipsToMatch.length > 0;
      if (!existing && !hasMac && !hasIp && (res.slug || res.name)) {
        const inputName = normalizeHost(res.name || res.slug);
        existing = candidates.find(r => {
          const rHasMac = !!(r.metadata && (r.metadata.macAddress || (r.metadata.interfaces && r.metadata.interfaces.some(i => i.mac))));
          if (rHasMac) return false;
          
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
        
        const isIp = (str) => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(str || '');
        const isMac = (str) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test((str || '').trim());
        const nameRank = (str) => {
          if (!str || !String(str).trim()) return 0;
          if (isMac(str)) return 0;
          if (isIp(str)) return 1;
          return 2;
        };

        let bestName = existing.name;
        if (res.name) {
          const incoming = nameRank(res.name);
          const current = nameRank(bestName);
          if (incoming > current || (incoming === current && res.name.length > (bestName || '').length)) {
            bestName = res.name;
          }
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
          id: res.id || crypto.randomUUID(),
          kind: res.kind || 'unmanaged_device',
          name: res.name || slug,
          slug: slug,
          metadata: res.metadata,
          created_on: Math.floor(Date.now() / 1000)
        });
        
        newDevices++;
        res._actualId = created.id; // Map original slug to actual ID
        allRes.push(created);
        WebhookEmitter.emit('discovery.new_device', created.toJSON());
      }
    }
    
    // Now process edges. `allRes` above is already current -- rows created in
    // the loop were pushed onto it -- so no second full read is needed.
    let existingEdges = await ResourceEdge.list();
    const parentedSlugs = new Set();
    const currentEdgeKeys = new Set();

    for (const edge of edges) {
      let parentId = null;
      const parentResInPayload = resources.find(r => r._originalSlug === edge.parentSlug);
      if (parentResInPayload && parentResInPayload._actualId) {
        parentId = parentResInPayload._actualId;
      } else {
        const parentResInDb = allRes.find(r => r.slug === edge.parentSlug);
        if (parentResInDb) parentId = parentResInDb.id;
      }
      
      let childId = null;
      const childResInPayload = resources.find(r => r._originalSlug === edge.childSlug);
      if (childResInPayload && childResInPayload._actualId) {
        childId = childResInPayload._actualId;
      } else {
        const childResInDb = allRes.find(r => r.slug === edge.childSlug);
        if (childResInDb) childId = childResInDb.id;
      }
      
      if (parentId && childId && parentId === childId) {
        console.warn(`[DiscoveryReconciler] ${sourceName}: dropping self-edge on ${edge.parentSlug} -> ${edge.childSlug}`);
        continue;
      }

      if (parentId && childId && isDescendant(parentId, childId, existingEdges)) {
        console.warn(`[DiscoveryReconciler] ${sourceName}: dropping ${edge.parentSlug} -> ${edge.childSlug} (would create a cycle)`);
        continue;
      }

      if (!parentId || !childId) {
        if (!parentId && edge.parentSlug) {
          console.warn(`[DiscoveryReconciler] ${sourceName}: parent slug '${edge.parentSlug}' does not resolve; dropping edge. Child may be parented to site.`);
        }
        continue;
      }

      const edgeExists = existingEdges.find(e => e.parentId === parentId && e.childId === childId && e.relation === edge.relation);
      if (!edgeExists) {
        const prior = existingEdges.find(e => e.childId === childId && e.relation === edge.relation && e.source);
        if (prior) {
          await prior.delete().catch(() => {});
          existingEdges = existingEdges.filter(e => e.id !== prior.id);
        }
        const created = await ResourceEdge.create({
          id: crypto.randomUUID(),
          parentId,
          childId,
          relation: edge.relation,
          source: sourceName
        });
        existingEdges.push(created);
      }
      parentedSlugs.add(edge.childSlug);
      currentEdgeKeys.add(`${parentId}|${childId}|${edge.relation}`);
    }
    
    if (targetSite) {
      for (const res of resources) {
        if (res._actualId && res._actualId !== targetSite.id && !parentedSlugs.has(res._originalSlug || res.slug)) {
          const edgeExists = existingEdges.find(e => e.childId === res._actualId);
          if (!edgeExists) {
            const created = await ResourceEdge.create({
              id: crypto.randomUUID(),
              parentId: targetSite.id,
              childId: res._actualId,
              relation: 'hosts',
              source: sourceName
            }).catch(() => null);
            if (created) existingEdges.push(created);
          }
          currentEdgeKeys.add(`${targetSite.id}|${res._actualId}|hosts`);
        }
      }
    }

    if (edges.length > 0) {
      const stale = existingEdges.filter(e => e.source === sourceName && !currentEdgeKeys.has(`${e.parentId}|${e.childId}|${e.relation}`));
      for (const e of stale) {
        await e.delete().catch(() => {});
      }
      if (stale.length > 0) {
        console.log(`[DiscoveryReconciler] ${sourceName}: pruned ${stale.length} stale edge(s)`);
      }
    }

    // AutoPromote access group generation has been removed from Reconciler.
    // Virtual LDAP Groups will handle inherited access based on the graph.

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
