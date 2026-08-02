const { Model } = require('@simpleworkjs/orm');

const { Group } = require('./group_ldap');

class Resource extends Model {
  static exposedMethods = [
    { method: 'search', route: 'resources', verb: 'get', args: { from: 'query' } },
    { method: 'getBySlug', route: 'resources/:slug', verb: 'get', args: { from: 'params', names: ['slug'] } },
    { method: 'getGraph', route: 'graph', verb: 'get' },
    { method: 'getMyAccess', route: 'me', verb: 'get', args: { from: 'user' } }
  ];

  static async search(query) {
    const graph = await this.getGraph();
    let resources = graph.resources;
    
    if (query.kind) {
      resources = resources.filter(r => r.kind === query.kind);
    }
    
    if (query.group) {
      const rgs = await ResourceGroup.list({ where: { groupCn: query.group } });
      const allowedIds = new Set(rgs.map(rg => rg.resourceId));
      resources = resources.filter(r => allowedIds.has(r.id));
    }

    if (query.parent) {
      const parents = graph.resources.filter(r => r.slug === query.parent);
      if (parents.length > 0) {
        const parentId = parents[0].id;
        const childIds = new Set(graph.edges.filter(e => e.parentId === parentId).map(e => e.childId));
        resources = resources.filter(r => childIds.has(r.id));
      } else {
        resources = [];
      }
    }
    return resources;
  }

  static async getBySlug(slug) {
    const graph = await this.getGraph();
    const resource = graph.resources.find(r => r.slug === slug);
    if (!resource) {
      let err = new Error('Resource not found');
      err.status = 404;
      throw err;
    }
    
    const parents = graph.edges.filter(e => e.childId === resource.id);
    const children = graph.edges.filter(e => e.parentId === resource.id);
    
    return {
      ...resource,
      parents,
      children
    };
  }

  static async getGraph() {
    const resources = await this.list();
    const edges = await ResourceEdge.list();
    
    // Convert to simple objects so we can mutate metadata properties safely
    const resObjs = resources.map(r => {
      const obj = r.toJSON ? r.toJSON() : { ...r };
      obj.metadata = obj.metadata || {};
      return obj;
    });
    
    // Bubble up production status: if any child is prod, parent is prod
    const isProdCache = new Map();
    function checkProd(resId, visited = new Set()) {
      if (isProdCache.has(resId)) return isProdCache.get(resId);
      if (visited.has(resId)) return false; // Cycle prevention
      
      visited.add(resId);
      const r = resObjs.find(x => x.id === resId);
      if (!r) return false;
      
      // If intrinsically prod, return true
      if (r.metadata.isProduction) {
        isProdCache.set(resId, true);
        return true;
      }
      
      // Check children
      const childrenIds = edges.filter(e => e.parentId === resId).map(e => e.childId);
      for (const cid of childrenIds) {
        if (checkProd(cid, visited)) {
          isProdCache.set(resId, true);
          return true;
        }
      }
      
      isProdCache.set(resId, false);
      return false;
    }
    
    let maxUpdated = 0;
    resObjs.forEach(r => {
      r.metadata.isProduction = checkProd(r.id);
      if (r.updated_on && r.updated_on > maxUpdated) maxUpdated = r.updated_on;
    });

    return { resources: resObjs, edges, updated_on: maxUpdated || Date.now() };
  }

  // Stamp `resolvedAddress` on each resource: its own address/ip if it has one,
  // otherwise the nearest ancestor's. A service usually carries no address of
  // its own -- it is reached at the host it runs on -- so "how do I reach this"
  // is only answerable from the graph, never from the row alone. Every caller
  // that answers that question for a user (getMyAccess, GET /api/discovery/me)
  // must go through here, or services come back unreachable.
  static async withResolvedAddress(resources) {
    if (!resources || !resources.length) return [];
    const graph = await this.getGraph();

    const resolve = (resId, visited = new Set()) => {
      if (visited.has(resId)) return null; // prevent cycles
      visited.add(resId);

      const res = graph.resources.find(r => r.id === resId);
      if (!res) return null;
      if (res.metadata && res.metadata.address) return res.metadata.address;
      if (res.metadata && res.metadata.ip) return res.metadata.ip;

      for (const edge of graph.edges.filter(e => e.childId === resId)) {
        const found = resolve(edge.parentId, visited);
        if (found) return found;
      }
      return null;
    };

    return resources.map(r => {
      const data = r.toJSON ? r.toJSON() : { ...r };
      data.metadata = data.metadata || {};
      data.resolvedAddress = resolve(data.id);
      return data;
    });
  }

  static async getMyAccess(userDn) {
    const userGroups = await Group.list(userDn);
    if (!userGroups || userGroups.length === 0) return [];

    const resourceGroups = await ResourceGroup.list({
      where: { groupCn: { in: userGroups } }
    });

    const resourceIds = [...new Set(resourceGroups.map(rg => rg.resourceId))];
    if (resourceIds.length === 0) return [];

    return this.withResolvedAddress(await this.list({ where: { id: { in: resourceIds } } }));
  }

  static fields = {
    id: { type: 'uuid', primaryKey: true },
    kind: { type: 'string', isRequired: true },
    name: { type: 'string', isRequired: true },
    slug: { type: 'string', isRequired: true, unique: true },
    owner: { type: 'string' },
    description: { type: 'text' },
    metadata: { type: 'json', default: {} },
    // Not isRequired: @simpleworkjs/orm has no auto-timestamp hook, so these
    // are set explicitly by the route handler on every create/update (see
    // routes/api_directory_admin.js). Existing rows predating this change
    // simply read back undefined -- callers must render a fallback.
    created_by: { type: 'string' },
    created_on: { type: 'integer' },
    updated_by: { type: 'string' },
    updated_on: { type: 'integer' },
    edgesAsParent: { type: 'hasMany', model: 'ResourceEdge', remoteKey: 'parentId' },
    edgesAsChild: { type: 'hasMany', model: 'ResourceEdge', remoteKey: 'childId' },
    groups: { type: 'hasMany', model: 'ResourceGroup', remoteKey: 'resourceId' }
  };

  // Walk parent ResourceEdges from resourceId up to the nearest ancestor
  // whose kind === 'site', returning its slug (or null if none exists -- a
  // top-level resource with no site parent keeps its unprefixed group name).
  static async findAncestorSiteSlug(resourceId, visited = new Set()) {
    if (visited.has(resourceId)) return null;
    visited.add(resourceId);

    const parentEdges = await ResourceEdge.list({ where: { childId: resourceId } });
    for (const edge of parentEdges) {
      const parent = await this.get(edge.parentId);
      if (!parent) continue;
      if (parent.kind === 'site') return parent.slug;
      const found = await this.findAncestorSiteSlug(parent.id, visited);
      if (found) return found;
    }
    return null;
  }
}

class ResourceEdge extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    parent: { type: 'hasOne', model: 'Resource' }, // Creates parentId
    child: { type: 'hasOne', model: 'Resource' }, // Creates childId
    relation: { type: 'string', isRequired: true }
  };
}

class ResourceGroup extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    resource: { type: 'hasOne', model: 'Resource' }, // Creates resourceId
    groupCn: { type: 'string', isRequired: true },
    accessLevel: { type: 'string', isRequired: true }
  };
}

module.exports = {
  Resource,
  ResourceEdge,
  ResourceGroup
};
