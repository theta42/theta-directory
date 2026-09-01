'use strict';

// Per-source fact provenance: a purely additive echo of what each discovery
// source reported, kept alongside (never instead of) the existing flat
// last-write-wins metadata merge.
//
// discovery_reconciler.js and agent_manager.js both merge incoming fields
// onto a resource's metadata with a flat `{...existing, ...incoming}` spread
// -- whichever source wrote last wins, and the loser's value is gone. That's
// unchanged by this file; nothing here alters what a `resource.metadata.*`
// read returns. This just also keeps a per-source copy under
// `metadata.facts_by_source`, so a later UI layer can show every source's
// value, not just the one that happened to write last.
//
// Blanket rule, not a curated field list: every source echoes everything it
// writes. A curated list is one more thing to remember to update as fields
// change -- exactly the kind of drift that produced the divergent, ad hoc
// duplicates this module replaces reasoning about case-by-case.
//
// See docs/resource-facts.md.

// Bookkeeping keys every source writes that are not "facts" about the
// resource and would just be noise duplicated under every source.
const EXCLUDED_KEYS = new Set(['discovery_sources', 'last_seen', 'facts_by_source']);

// Echo every defined field in `fields` under
// mergedMeta.facts_by_source[sourceName], stamped with when this source last
// reported it. Mutates and returns mergedMeta for convenient chaining at the
// call site.
function recordFactSources(mergedMeta, sourceName, fields) {
  if (!mergedMeta || !sourceName || !fields) return mergedMeta;

  const echoed = {};
  for (const key of Object.keys(fields)) {
    if (EXCLUDED_KEYS.has(key)) continue;
    if (fields[key] === undefined) continue;
    echoed[key] = fields[key];
  }
  if (!Object.keys(echoed).length) return mergedMeta;

  mergedMeta.facts_by_source = { ...(mergedMeta.facts_by_source || {}) };
  mergedMeta.facts_by_source[sourceName] = { ...echoed, observed_at: Date.now() };
  return mergedMeta;
}

module.exports = { recordFactSources };
