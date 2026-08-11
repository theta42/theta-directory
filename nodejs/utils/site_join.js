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

// Provenance marker written into a replicated resource's metadata. It is what
// makes deletion safe to propagate: a spoke's own bootstrap seeds resources
// the master has never heard of (its own site, its own host, its own
// services), so "delete anything not in the master's export" would wipe the
// spoke's local catalog. Only rows THIS import created or adopted carry the
// stamp, and only stamped rows are eligible for removal.
const REPLICATED_FROM = '__replicatedFrom';

// edgeKey identifies an edge by what it MEANS (which two resources, which
// relation) rather than by its row id. The master's edge ids are useless as
// local identity once resource ids are remapped below, and reconciling on the
// triple is what makes a re-import converge instead of thrash.
function edgeKey(parentId, childId, relation) {
  return `${parentId}|${childId}|${relation || 'runs_on'}`;
}

// importDirectory adopts a master's resource catalog into the local store.
// Resources are upserted by slug (create if absent, update if a local row
// already exists — the master is authoritative for the shared catalog), then
// the edge graph is reconciled toward the master's.
//
// Three things this deliberately does NOT do, each of which it used to:
//
//  1. It no longer calls `Resource.update(id, data)` / `ResourceEdge.delete(id)`.
//     @simpleworkjs/orm has no such STATICS — update/delete are instance
//     methods (lib/base.js). Both calls threw "is not a function" into a
//     swallowing catch, so on every real spoke: existing resources were never
//     updated (a rename or metadata edit on the master never propagated), and
//     the edge-clear loop aborted on its first iteration (so edge DELETIONS on
//     the master never propagated either). The injected test stubs happened to
//     implement those two as statics, which is exactly why the unit tests
//     passed while production silently no-op'd — the stubs now mirror the real
//     instance-method shape. See tests/orm_method_guard.test.js, which now
//     catches this whole class.
//
//  2. It no longer deletes every edge before recreating them. That left a
//     window where a crash/restart mid-import stranded the spoke with a
//     truncated graph. Creates land first, extras are removed afterward, so an
//     interrupted import leaves a SUPERSET (harmless, and the next resync
//     converges) rather than a hole. This is the same reasoning as the
//     push-a-signal/pull-a-snapshot design in site_replicate.js: a partial
//     application must always be recoverable by re-running it, which is a
//     stronger property here than atomicity would be (the ORM has no
//     transaction plumbing to hand a `transaction:` through, and wrapping the
//     calls in sequelize.transaction() without CLS would produce a rollback
//     that silently doesn't roll anything back).
//
//  3. It no longer assumes the master's resource ids are usable verbatim.
//     A spoke's own bootstrap seeds resources with locally-generated ids, and
//     several slugs are fixed strings every site shares (`openresty`,
//     `host_theta-proxy`, ...). Adopting the master's edges by raw id then
//     pointed at ids that don't exist locally. Edge endpoints are remapped
//     master-id -> slug -> local-id, and an edge whose endpoints can't be
//     resolved locally is skipped rather than written as a dangling row.
async function importDirectory({ Resource, ResourceEdge, exportData }) {
  const resources = (exportData && exportData.resources) || [];
  const edges = (exportData && exportData.edges) || [];

  const bySlug = new Map();
  try {
    const existing = await Resource.list();
    (existing || []).forEach(r => { bySlug.set(r.slug, r); });
  } catch (e) {
    // Resource.list is unavailable (fresh DB?) — treat as empty.
  }

  // The master's own id -> slug, so edges (which reference ids) can be
  // translated into local ids below.
  const masterIdToSlug = new Map();
  const desiredSlugs = new Set();
  const origin = (exportData && exportData.siteSlug) || 'master';
  let created = 0;
  let updated = 0;
  for (const raw of resources) {
    const s = scalarResource(raw);
    if (!s.slug) continue;
    if (s.id) masterIdToSlug.set(s.id, s.slug);
    desiredSlugs.add(s.slug);
    // Provenance stamp — see the removal pass below for why this is needed
    // before anything on a spoke can safely be deleted.
    s.metadata = { ...(s.metadata || {}), [REPLICATED_FROM]: origin };
    const local = bySlug.get(s.slug);
    if (local) {
      // Never repoint an existing row's primary key: local rows may already
      // be referenced (ResourceGroup, local edges). The slug is the identity
      // that matters, and the id remap below makes the graph line up anyway.
      const { id, ...patch } = s;
      try {
        await local.update(patch);
        updated++;
      } catch (e) { /* row raced or is locally pinned; next resync retries */ }
    } else {
      try {
        const row = await Resource.create(s);
        if (row) bySlug.set(s.slug, row);
        created++;
      } catch (e) { /* duplicate-slug race; ignore */ }
    }
  }

  // Refresh the slug -> local id map from what is actually on disk now (a
  // create() may have assigned its own id rather than honoring s.id).
  const localIdBySlug = new Map();
  try {
    const now = await Resource.list();
    (now || []).forEach(r => { localIdBySlug.set(r.slug, r.id); });
  } catch (e) {
    for (const [slug, row] of bySlug) localIdBySlug.set(slug, row && row.id);
  }

  const localIdFor = (masterId) => {
    const slug = masterIdToSlug.get(masterId);
    if (slug && localIdBySlug.has(slug)) return localIdBySlug.get(slug);
    return null;
  };

  // Desired edge set, in local id space.
  const desired = new Map();
  let skipped = 0;
  for (const raw of edges) {
    const s = scalarEdge(raw);
    if (!s.parentId || !s.childId) continue;
    const parentId = localIdFor(s.parentId);
    const childId = localIdFor(s.childId);
    if (!parentId || !childId) { skipped++; continue; }
    const relation = s.relation || 'runs_on';
    desired.set(edgeKey(parentId, childId, relation), { parentId, childId, relation });
  }

  let existingEdges = [];
  try {
    existingEdges = (await ResourceEdge.list()) || [];
  } catch (e) {
    // A fresh DB legitimately has no edge table yet, but anything else here
    // means the removal half below silently does nothing — which is how the
    // original ResourceEdge.delete() bug stayed invisible. Say so.
    console.error('[site-join] could not list local edges; stale edges will not be reconciled:', e.message);
  }
  const present = new Set(existingEdges.map(e => edgeKey(e.parentId, e.childId, e.relation)));

  // Additions first (see note 2 above).
  let edgeCount = 0;
  for (const [key, e] of desired) {
    if (present.has(key)) { edgeCount++; continue; }
    try {
      await ResourceEdge.create({ parentId: e.parentId, childId: e.childId, relation: e.relation });
      edgeCount++;
    } catch (err) { /* raced; next resync converges */ }
  }

  // Then removals: anything the master no longer has. This is the half that
  // never ran at all before, so spokes accumulated edges the master had
  // already deleted.
  let edgesRemoved = 0;
  for (const e of existingEdges) {
    if (desired.has(edgeKey(e.parentId, e.childId, e.relation))) continue;
    try { await e.delete(); edgesRemoved++; } catch (err) { /* ignore */ }
  }

  // Finally, resources the master has deleted. Only ones this replication
  // path put here (REPLICATED_FROM) are eligible — never the spoke's own
  // locally-bootstrapped rows, which the master has never had and must not
  // lose. Runs after the edge pass so an about-to-be-deleted resource isn't
  // left referenced by an edge in between.
  let resourcesRemoved = 0;
  let localRows = [];
  try {
    localRows = (await Resource.list()) || [];
  } catch (e) {
    console.error('[site-join] could not list local resources; deletions will not be reconciled:', e.message);
  }
  for (const row of localRows) {
    if (desiredSlugs.has(row.slug)) continue;
    const stamp = row.metadata && row.metadata[REPLICATED_FROM];
    if (!stamp) continue; // locally-owned; not ours to delete
    try { await row.delete(); resourcesRemoved++; } catch (err) { /* ignore */ }
  }

  return { created, updated, resourcesRemoved, edgeCount, edgesRemoved, edgesSkipped: skipped };
}

// Operational attributes: slapd maintains these itself and rejects any
// attempt to write them (NO-USER-MODIFICATION). `slapcat` emits them, so the
// export's LDIF cannot be handed to `ldapadd` as-is -- every entry comes back
// "Constraint violation (19): structuralObjectClass: no user modification
// allowed". slapadd would accept them, but it is an OFFLINE tool: using it
// would mean stopping the spoke's running slapd mid-join.
//
// So the export is filtered here instead. This was the second half of why the
// LDAP side of a join had never actually worked (the first being the missing
// argv[0] below) -- both were invisible because the failure only ever reached
// a note string nothing asserted on.
const OPERATIONAL_ATTRS = new Set([
  'structuralobjectclass', 'entryuuid', 'creatorsname', 'createtimestamp',
  'entrycsn', 'modifiersname', 'modifytimestamp', 'contextcsn',
  'subschemasubentry', 'hassubordinates', 'entrydn', 'nsuniqueid',
  'pwdchangedtime', 'pwdfailuretime', 'pwdaccountlockedtime',
  // Maintained by the memberof overlay from the group's member attribute;
  // writing it directly is refused the same way.
  'memberof'
]);

// ldapadd -c continues past per-entry failures but still exits non-zero, so
// exit status alone cannot distinguish "nothing imported" from "imported,
// and the entries this spoke already had were skipped". The latter is the
// NORMAL case: every spoke already has its own root, admin and ou entries.
// Reporting that as a failure is what made a healthy join look broken.
//
// Error 68 (Already exists) is benign here by design -- `-c` exists precisely
// so the import continues past it. Anything else is a real problem.
function summarizeLdapAddResult(stderr) {
  const text = String(stderr || '');
  const codes = [...text.matchAll(/ldap_add:\s*([^(]+)\((\d+)\)/g)]
    .map((m) => ({ message: m[1].trim(), code: Number(m[2]) }));
  if (codes.length === 0) return { ok: false, note: null };

  const alreadyExists = codes.filter((c) => c.code === 68);
  const real = codes.filter((c) => c.code !== 68);
  if (real.length === 0) {
    return { ok: true, note: `imported (${alreadyExists.length} entries already present, skipped)` };
  }
  const distinct = [...new Set(real.map((c) => `${c.message} (${c.code})`))];
  return {
    ok: false,
    note: `partial: ${real.length} of ${codes.length} entries rejected -- ${distinct.join('; ')}`
  };
}

// stripOperationalAttrs removes those attributes from an LDIF, honoring LDIF
// line folding (a continuation line starts with a space and belongs to the
// attribute above it, so it has to be dropped with it).
function stripOperationalAttrs(ldif) {
  const out = [];
  let dropping = false;
  for (const line of String(ldif || '').split('\n')) {
    if (line.startsWith(' ')) {
      // Continuation of whatever came before -- follow that decision.
      if (!dropping) out.push(line);
      continue;
    }
    const colon = line.indexOf(':');
    const name = colon > 0 ? line.slice(0, colon) : '';
    dropping = OPERATIONAL_ATTRS.has(name.toLowerCase());
    if (!dropping) out.push(line);
  }
  return out.join('\n');
}

// ldapAddArgs builds the argv for importing an LDIF into the local slapd with
// the app's admin bind. `-c` continues past "entry already exists" (the spoke
// keeps its own cn=admin / base DN).
//
// argv[0] is the COMMAND. It was missing, so the only caller --
// `execFileAsync(argv[0], argv.slice(1))` in routes/api_site.js -- tried to
// execute `-c` as a program and every join and resync failed with
// "spawn -c ENOENT". That failure was swallowed into the ldapNote string, and
// nothing (unit test or e2e) ever asserted on that note, so the LDAP half of
// multi-site join had in fact never run: a spoke adopted the resource catalog
// and the signing key, but not one user or group. Caught by the e2e only once
// it started asserting ldap.note === 'imported'.
function ldapAddArgs({ bindDN, ldapCred, ldifFile, ldapUrl }) {
  return [
    'ldapadd',
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

module.exports = {
  scalarResource, scalarEdge, edgeKey, REPLICATED_FROM, importDirectory,
  stripOperationalAttrs, OPERATIONAL_ATTRS, summarizeLdapAddResult,
  ldapAddArgs, baseDnFrom, siteIsFresh
};
