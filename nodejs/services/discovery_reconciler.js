const { Resource, ResourceEdge, ResourceGroup } = require('../models/resource');
const { identityClassFor } = require('./subtype_templates');
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
      // This directory's OWN site, not sites[0]. On a master holding a row for
      // every spoke, sites[0] is whichever site happens to sort first -- so a
      // plugin with no location configured could file a rack of machines into
      // a different office entirely.
      const sites = await Resource.list({ where: { kind: 'site' } });
      targetSite = (sites || []).find(s => s.metadata && s.metadata.isCurrentSite) || null;
      if (!targetSite && sites && sites.length === 1) targetSite = sites[0];
      if (!targetSite && sites && sites.length > 1) {
        console.warn(
          `[DiscoveryReconciler] ${sourceName}: no location configured and no current-site row; ` +
          `refusing to guess between ${sites.length} sites.`);
        return;
      }
      if (!targetSite) {
        targetSite = await Resource.create({
          id: crypto.randomUUID(),
          kind: 'site',
          name: 'Default Site',
          slug: 'site_default',
          metadata: { isCurrentSite: true },
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
    const allEdges = await ResourceEdge.list();

    // Which site each existing resource belongs to, by walking parent edges up
    // to the nearest site. This is what makes weak (IP/name) matching
    // site-local: without it, two racks that both run a box called `ubuntu` on
    // 192.168.1.50 merge into one resource.
    const resById = new Map(allRes.map(r => [r.id, r]));
    const parentIndex = new Map();
    for (const e of allEdges) {
      if (!e.childId || !e.parentId) continue;
      if (!parentIndex.has(e.childId)) parentIndex.set(e.childId, []);
      parentIndex.get(e.childId).push(e.parentId);
    }

    const siteOf = new Map();
    function computeSiteOf(resourceId, visited = new Set()) {
      if (siteOf.has(resourceId)) return siteOf.get(resourceId);
      // Cycle: no answer for THIS traversal. Deliberately not cached -- a null
      // that only means "we came back around" would be handed to every later
      // lookup as if it were the real answer.
      if (visited.has(resourceId)) return null;
      visited.add(resourceId);

      const res = resById.get(resourceId);
      if (res && res.kind === 'site') {
        siteOf.set(resourceId, res.id);
        return res.id;
      }
      let found = null;
      for (const parentId of parentIndex.get(resourceId) || []) {
        found = computeSiteOf(parentId, visited);
        if (found) break;
      }
      if (found || visited.size === 1) siteOf.set(resourceId, found);
      return found;
    }
    for (const r of allRes) computeSiteOf(r.id);
    const incomingSiteId = targetSite ? targetSite.id : null;

    for (const res of resources) {
      if (!res.metadata) res.metadata = {};
      if (autoPromote) res.metadata.managed = true;
      res._originalSlug = res.slug; // Keep track for edge mapping

      let existing = null;

      // A discovered device may only merge into a resource of the same IDENTITY
      // CLASS. Without this a VM called "gitea-runner" matches a hand-created
      // *service* of the same name on rule 3 and silently overwrites it -- the
      // discovered host's metadata lands on a service row, and the operator's
      // entry is gone.
      //
      // Identity class is finer than kind (services/subtype_templates.js): a
      // template counts as its host, a container as a service, and an
      // out-of-band controller is its own class so an iLO's management NIC can
      // never fold into the server it manages.
      const incomingClass = identityClassFor(res);
      const candidates = allRes.filter(r => {
        const k = identityClassFor(r);
        // A placeholder from an earlier, kind-less discovery matches anything.
        if (k === 'unmanaged_device' || incomingClass === 'unmanaged_device') return true;
        return k === incomingClass;
      });

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
          // Strict boundaries: never hijack a resource that already has a strong identity (MAC).
          const rHasMac = !!(r.metadata && (r.metadata.macAddress || (r.metadata.interfaces && r.metadata.interfaces.some(i => i.mac))));
          if (rHasMac) return false;
          // Strict boundaries: IP fallback only within the same site.
          if (incomingSiteId && siteOf.get(r.id) !== incomingSiteId) return false;
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
          // Strict boundaries: name/slug fallback only within the same site.
          if (incomingSiteId && siteOf.get(r.id) !== incomingSiteId) return false;
          
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
        // New rows have no edges yet; weak matching later in this payload
        // should treat them as belonging to the target site.
        siteOf.set(created.id, incomingSiteId);
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

      // If a guest host is structurally parented under a hypervisor node, prune
      // any redundant direct parent edge from the enclosing site resource.
      if (edge.relation === 'hosts') {
        const redundantSiteEdges = existingEdges.filter(e => e.childId === childId && e.relation === 'hosts' && e.parentId !== parentId);
        for (const rse of redundantSiteEdges) {
          const parentRes = allRes.find(r => r.id === rse.parentId);
          if (parentRes && parentRes.kind === 'site') {
            await rse.delete().catch(() => {});
            existingEdges = existingEdges.filter(e => e.id !== rse.id);
            console.log(`[DiscoveryReconciler] pruned redundant direct site edge ${rse.parentId} -> ${childId}`);
          }
        }
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

    // Reconcile stale resources previously discovered by this source:
    // When a structural discovery source reports an inventory of resources and edges (e.g. Proxmox, Docker),
    // any resource that previously carried this discovery_source but is no longer reported in this run
    // has vanished from the underlying host/hypervisor.
    if (resources.length > 0) {
      const reportedIds = new Set(resources.map(r => r._actualId).filter(Boolean));
      for (const res of allRes) {
        const meta = res.metadata || {};
        const sources = meta.discovery_sources || [];
        if (!sources.includes(sourceName) || reportedIds.has(res.id)) continue;

        const otherSources = sources.filter(s => s !== sourceName);
        const isManual = res.created_by || sources.includes('manual') || res.kind === 'site';

        if (otherSources.length > 0 || isManual) {
          await res.update({
            metadata: { ...meta, discovery_sources: otherSources },
            updated_on: Math.floor(Date.now() / 1000)
          }).catch(() => {});
        } else if (edges.length > 0) {
          // Exclusively discovered by this source which emits parent-child topology (e.g. Proxmox, Docker).
          // The device has been removed from the underlying hypervisor/host.
          const [asChild, asParent] = await Promise.all([
            ResourceEdge.list({ where: { childId: res.id } }).catch(() => []),
            ResourceEdge.list({ where: { parentId: res.id } }).catch(() => [])
          ]);
          for (const e of [...asChild, ...asParent]) await e.delete().catch(() => {});
          const links = await ResourceGroup.list({ where: { resourceId: res.id } }).catch(() => []);
          for (const l of links) await l.delete().catch(() => {});
          await res.delete().catch(() => {});
          WebhookEmitter.emit('discovery.device_purged', res.toJSON ? res.toJSON() : res);
          console.log(`[DiscoveryReconciler] ${sourceName}: purged vanished discovered resource '${res.slug}'`);
        }
      }
    }

    // AutoPromote access group generation has been removed from Reconciler.
    // Virtual LDAP Groups will handle inherited access based on the graph.

    if (newDevices > 0) {
      console.log(`[DiscoveryReconciler] Source ${sourceName} discovered ${newDevices} new devices.`);
    }
  }

  // Retire discovery output nobody has seen for a while.
  //
  // This used to set `metadata.lifecycle_state = 'archived'` and stop. That
  // field was written here and read NOWHERE -- not by the projection, not by
  // the tree, not by jump-host -- so "garbage collection" changed a string on a
  // row and nothing else. Stale devices stayed fully visible and fully
  // reachable forever.
  //
  // Two stages, because deleting on first sight of staleness is too eager for a
  // laptop that went on holiday, and never deleting is what we had:
  //
  //   archived  after `staleMs`  -- hidden from the catalog, still in the
  //                                 database, trivially restored by being
  //                                 discovered again.
  //   deleted   after `purgeMs`  -- gone, with its edges.
  //
  // Only ever touches rows that are exclusively auto-discovered and NOT
  // managed. Anything an operator promoted or created is catalog content and is
  // never collected, however long it has been quiet.
  // Everything a discovery source put in the graph, when that source is going
  // away.
  //
  // Deleting a plugin instance used to unschedule it, drop its secrets and
  // delete the row -- and leave every resource and edge it had created behind,
  // tagged with a source name that will never run again. Pruning only happens
  // during a run of the owning source, so those rows were unreachable by any
  // cleanup path that exists: permanent litter, growing with every plugin an
  // operator tried and removed.
  //
  // `keepPromoted` (the default) leaves anything an operator promoted or
  // created by hand. Those are catalog content that merely happened to be found
  // by this plugin; removing the plugin is not a decision to delete them. They
  // just lose the source attribution.
  static async forgetSource(sourceName, { keepPromoted = true } = {}) {
    if (!sourceName) return { removed: 0, kept: 0, edgesRemoved: 0 };
    const allRes = await Resource.list();
    let removed = 0;
    let kept = 0;
    let edgesRemoved = 0;

    for (const res of allRes) {
      const meta = res.metadata || {};
      const sources = meta.discovery_sources || [];
      if (!sources.includes(sourceName)) continue;

      // Found by more than one source: it is still someone else's, so only drop
      // our attribution.
      const others = sources.filter(x => x !== sourceName);
      const promoted = meta.managed === true || sources.includes('manual');

      if (others.length || (keepPromoted && promoted)) {
        await res.update({
          metadata: { ...meta, discovery_sources: others },
          updated_on: Math.floor(Date.now() / 1000)
        }).catch(() => {});
        kept++;
        continue;
      }

      const [asChild, asParent] = await Promise.all([
        ResourceEdge.list({ where: { childId: res.id } }).catch(() => []),
        ResourceEdge.list({ where: { parentId: res.id } }).catch(() => [])
      ]);
      for (const e of [...asChild, ...asParent]) {
        await e.delete().catch(() => {});
        edgesRemoved++;
      }
      const links = await ResourceGroup.list({ where: { resourceId: res.id } }).catch(() => []);
      for (const l of links) await l.delete().catch(() => {});
      await res.delete().catch(() => {});
      removed++;
    }

    // Edges this source created between resources that survived for other
    // reasons: the resource stays, its provenance does not.
    const orphanEdges = (await ResourceEdge.list().catch(() => []))
      .filter(e => e.source === sourceName);
    for (const e of orphanEdges) {
      await e.delete().catch(() => {});
      edgesRemoved++;
    }

    console.log(`[DiscoveryReconciler] forgetSource(${sourceName}): removed ${removed}, kept ${kept}, edges ${edgesRemoved}`);
    return { removed, kept, edgesRemoved };
  }

  static async garbageCollect(staleMs = 7 * 24 * 60 * 60 * 1000, purgeMs = 30 * 24 * 60 * 60 * 1000) {
    const allRes = await Resource.list();
    const now = Date.now();
    const staleCutoff = now - staleMs;
    const purgeCutoff = now - purgeMs;
    let archived = 0;
    let purged = 0;

    const collectable = (res) => {
      const meta = res.metadata || {};
      if (meta.managed === true) return false;
      const sources = meta.discovery_sources || [];
      if (!sources.length || sources.includes('manual')) return false;
      return true;
    };

    for (const res of allRes) {
      if (!collectable(res)) continue;
      const meta = res.metadata || {};
      const lastSeen = meta.last_seen;
      if (!lastSeen) continue;

      if (lastSeen < purgeCutoff) {
        // Edges first: a row deleted before them leaves edges pointing at an id
        // that no longer exists, which getGraph() cannot render around.
        const [asChild, asParent] = await Promise.all([
          ResourceEdge.list({ where: { childId: res.id } }).catch(() => []),
          ResourceEdge.list({ where: { parentId: res.id } }).catch(() => [])
        ]);
        for (const e of [...asChild, ...asParent]) await e.delete().catch(() => {});
        const links = await ResourceGroup.list({ where: { resourceId: res.id } }).catch(() => []);
        for (const l of links) await l.delete().catch(() => {});
        await res.delete().catch(() => {});
        purged++;
        WebhookEmitter.emit('discovery.device_purged', res.toJSON());
        continue;
      }

      if (lastSeen < staleCutoff && meta.lifecycle_state !== 'archived') {
        // A NEW object, not the mutated original. `meta` is `res.metadata` by
        // reference, and handing the ORM back the same object it already holds
        // is not seen as a change -- the row is never written. The previous
        // version of this function did exactly that, which is the second reason
        // garbage collection did nothing: the flag nothing read was also a flag
        // that was never actually saved.
        await res.update({
          metadata: { ...meta, lifecycle_state: 'archived' },
          updated_on: Math.floor(Date.now() / 1000)
        });
        archived++;
        WebhookEmitter.emit('discovery.device_archived', res.toJSON());
      }
    }

    if (archived || purged) {
      console.log(`[DiscoveryReconciler] garbage collection: archived ${archived}, purged ${purged}`);
    }
    return { archived, purged };
  }

}

module.exports = { DiscoveryReconciler, isDescendant };
