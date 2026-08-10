'use strict';

// Pure, testable helpers for the multi-site join flow (MULTI_SITE_SPEC.md).
// routes/api_site.js wires these to Express + the live models + slapcat/ldapadd;
// tests exercise importDirectory with in-memory model stubs.

// scalarResource reduces a Resource row to its scalar columns so it can be
// re-created on a spoke without dragging hasMany relation fields along.
function scalarResource(r) {
  const o = (r && r.toJSON) ? r.toJSON() : (r || {});
  return {
    id: o.id,
    kind: o.kind,
    name: o.name,
    slug: o.slug,
    owner: o.owner || null,
    description: o.description || null,
    metadata: o.metadata || {},
    created_by: o.created_by || null,
    created_on: o.created_on || null,
    updated_by: o.updated_by || null,
    updated_on: o.updated_on || null
  };
}

function scalarEdge(e) {
  const o = (e && e.toJSON) ? e.toJSON() : (e || {});
  return {
    id: o.id,
    parentId: o.parentId,
    childId: o.childId,
    relation: o.relation
  };
}

// importDirectory adopts a master's resource catalog into the local SQLite
// store. Resources are upserted by slug (create if absent, update if a local
// row already exists — the master is authoritative for the shared catalog),
// then all edges are recreated. Model stubs are injected for testability.
async function importDirectory({ Resource, ResourceEdge, exportData }) {
  const resources = (exportData && exportData.resources) || [];
  const edges = (exportData && exportData.edges) || [];

  const bySlug = {};
  try {
    const existing = await Resource.list();
    (existing || []).forEach(r => { bySlug[r.slug] = r; });
  } catch (e) {
    // Resource.list is unavailable (fresh DB?) — treat as empty.
  }

  let created = 0;
  let updated = 0;
  for (const raw of resources) {
    const s = scalarResource(raw);
    if (!s.slug) continue;
    const local = bySlug[s.slug];
    if (local) {
      try { await Resource.update(local.id, s); updated++; } catch (e) { /* row raced; ignore */ }
    } else {
      try { await Resource.create(s); created++; } catch (e) { /* duplicate-slug race; ignore */ }
    }
  }

  // Edges: clear + recreate so the graph matches the master exactly.
  try {
    const existingEdges = await ResourceEdge.list();
    for (const e of existingEdges || []) {
      await ResourceEdge.delete(e.id).catch(() => {});
    }
  } catch (e) { /* ignore */ }
  let edgeCount = 0;
  for (const raw of edges) {
    const s = scalarEdge(raw);
    if (!s.parentId || !s.childId) continue;
    try { await ResourceEdge.create({ id: s.id, parentId: s.parentId, childId: s.childId, relation: s.relation || 'runs_on' }); edgeCount++; } catch (e) { /* ignore */ }
  }

  return { created, updated, edgeCount };
}

// ldapAddArgs builds the argv for importing an LDIF into the local slapd with
// the app's admin bind. `-c` continues past "entry already exists" (the spoke
// keeps its own cn=admin / base DN).
function ldapAddArgs({ bindDN, ldapCred, ldifFile, ldapUrl }) {
  return [
    '-c', '-x',
    '-H', ldapUrl || 'ldap://localhost',
    '-D', bindDN,
    '-w', ldapCred,
    '-f', ldifFile
  ];
}

// baseDnFrom derives the LDAP base DN from the app's admin bindDN
// (cn=admin,dc=example,dc=com -> dc=example,dc=com) unless the stack config
// already provides it (conf.stack.ldapBaseDn, written by setup.sh).
function baseDnFrom(conf) {
  if (conf.stack && conf.stack.ldapBaseDn) return conf.stack.ldapBaseDn;
  const m = String((conf.ldap && conf.ldap.bindDN) || '').match(/^cn=[^,]+,(.+)$/);
  return m ? m[1] : '';
}

// siteIsFresh reports whether this deployment may join a master site
// (MULTI_SITE_SPEC.md): no users beyond the bootstrap admin and no enrolled
// agents. The bootstrap always seeds a handful of default resources (site →
// host → sso/proxy services), so resources are NOT the signal — the operator's
// rule is "no users". A directory with real users must never be merged into a
// master's; that is the destructive case this guard prevents.
async function siteIsFresh({ User, Agent }) {
  const agents = (Agent && Agent.list ? await Agent.list().catch(() => []) : []);
  if (agents && agents.length > 0) return false;
  if (User && typeof User.listDetail === 'function') {
    try {
      const users = await User.listDetail();
      const real = (users || []).filter(u => !u.isServiceAccount);
      return real.length <= 1; // at most the bootstrap admin
    } catch (e) {
      // LDAP unreachable — fall back to the agent-only check.
    }
  }
  return true;
}

module.exports = { scalarResource, scalarEdge, importDirectory, ldapAddArgs, baseDnFrom, siteIsFresh };
