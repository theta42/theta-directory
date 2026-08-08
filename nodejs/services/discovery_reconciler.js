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
        const locSlug = `site-${locStr.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
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
          slug: 'site-default',
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

      // 1. Attempt matching by MAC (highest precision)
      if (res.metadata.interfaces && res.metadata.interfaces.length > 0) {
        const macs = res.metadata.interfaces.map(i => normalizeMac(i.mac)).filter(m => m.length === 12);
        if (macs.length > 0) {
          existing = candidates.find(r =>
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
        existing = candidates.find(r => {
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
        existing = candidates.find(r => {
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
        
        // Pick the most human name across sources. Rank first, length only as
        // a tie-break within a rank -- comparing lengths alone let a UniFi
        // client named after its MAC ("ac:16:2d:b3:da:80", 17 chars) beat the
        // hypervisor's real hostname from Proxmox ("dl380-0", 7), so the
        // Directory listed MAC addresses where host names belong.
        //
        // NB: `\\.` inside a regex LITERAL matches a backslash, not a dot, so
        // the old isIp returned false for every input and IP-shaped names were
        // never replaced either. It is `\.` here.
        const isIp = (str) => /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(str || '');
        const isMac = (str) => /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test((str || '').trim());
        // 2 = a real name, 1 = an IP (at least routable/recognizable), 0 = a
        // MAC or nothing (pure machine identifier, the worst thing to show).
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
          id: crypto.randomUUID(),
          kind: res.kind || 'unmanaged_device',
          name: res.name || slug,
          slug: slug,
          metadata: res.metadata,
          created_on: Math.floor(Date.now() / 1000)
        });
        
        newDevices++;
        res._actualId = created.id; // Map original slug to actual ID
        // Make it visible to the rest of THIS payload: a Proxmox run reports
        // the endpoint, then its nodes, then their guests, and two of them can
        // legitimately share a MAC/IP. Without this the same device could be
        // created twice in a single run.
        allRes.push(created);
        WebhookEmitter.emit('discovery.new_device', created.toJSON());
      }
    }
    
    // Now process edges. `allRes` above is already current -- rows created in
    // the loop were pushed onto it -- so no second full read is needed.
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
      
      // Two slugs in one payload can resolve to the SAME resource once the
      // matcher has merged them -- a Proxmox endpoint reached at the address
      // of the node that answers for it is the case that produced this. The
      // edge would then make a resource its own parent, which renders as an
      // infinitely nested tree and defeats every ancestor walk in the app
      // (findAncestorSiteSlug, withResolvedAddress) that relies on a cycle
      // guard to terminate rather than to be correct.
      if (parentId && childId && parentId === childId) {
        console.warn(`[DiscoveryReconciler] ${sourceName}: dropping self-edge on ${edge.parentSlug} -> ${edge.childSlug} (both resolved to the same resource)`);
        continue;
      }

      // Likewise refuse an edge that closes a loop: if the proposed parent is
      // already a descendant of the proposed child, adding this makes a cycle.
      if (parentId && childId && isDescendant(parentId, childId, existingEdges)) {
        console.warn(`[DiscoveryReconciler] ${sourceName}: dropping ${edge.parentSlug} -> ${edge.childSlug} (would create a cycle)`);
        continue;
      }

      if (parentId && childId) {
        const edgeExists = existingEdges.find(e => e.parentId === parentId && e.childId === childId && e.relation === edge.relation);
        if (!edgeExists) {
          const created = await ResourceEdge.create({
            id: crypto.randomUUID(),
            parentId,
            childId,
            relation: edge.relation
          });
          // Keep the in-memory edge list current so the cycle check above sees
          // edges added earlier in this same payload.
          existingEdges.push(created);
        }
      }
    }
    
    if (targetSite) {
      const childSlugs = new Set(edges.map(e => e.childSlug));
      for (const res of resources) {
        if (res._actualId && res._actualId !== targetSite.id && !childSlugs.has(res._originalSlug || res.slug)) {
          const edgeExists = existingEdges.find(e => e.childId === res._actualId);
          if (!edgeExists) {
            const created = await ResourceEdge.create({
              id: crypto.randomUUID(),
              parentId: targetSite.id,
              childId: res._actualId,
              relation: 'hosts'
            }).catch(() => null);
            if (created) existingEdges.push(created);
          }
        }
      }
    }

    if (autoPromote) {
      const { Group } = require('../models/group_ldap');
      for (const res of resources) {
        if (!res._actualId) continue;
        const accessGroup = `${res.slug}_access`;
        const adminGroup = `${res.slug}_admin`;
        try {
          await Group.get(accessGroup).catch(async (e) => {
            if (e.status === 404) await Group.add({ name: accessGroup, description: `Access to ${res.name}`, owner: 'cn=admin' });
          });
          await Group.get(adminGroup).catch(async (e) => {
            if (e.status === 404) await Group.add({ name: adminGroup, description: `Admin access to ${res.name}`, owner: 'cn=admin' });
          });
          await ResourceGroup.create({ id: crypto.randomUUID(), resourceId: res._actualId, groupCn: accessGroup, accessLevel: 'user' }).catch(() => {});
          await ResourceGroup.create({ id: crypto.randomUUID(), resourceId: res._actualId, groupCn: adminGroup, accessLevel: 'admin' }).catch(() => {});
        } catch (err) {
          console.error(`[DiscoveryReconciler] autoPromote failed for ${res.slug}:`, err.message);
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
