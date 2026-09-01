'use strict';

// Resource identity matching: given a candidate pool (already scoped to the
// right identity class by the caller) and an incoming resource description,
// find the existing resource it should merge into. Four tiers, in strength
// order, each attempted only if the previous one didn't decide the answer:
// UUID -> MAC -> IP -> name/slug.
//
// Extracted from discovery_reconciler.js so agent_manager.js's host-
// consolidation path (merging an agent's auto-created placeholder host into
// a richer existing one) can share the same safety properties instead of
// maintaining its own weaker copy:
//
//   - MAC-hijack guard: a resource that already has its own MAC identity can
//     never be matched by a weaker IP/name guess (hasStrongIdentity).
//   - Same-site scoping for the IP and name/slug tiers only. A MAC survives a
//     device moving between sites, so the MAC tier is deliberately never
//     site-scoped.
//   - A MAC or IP that was present in the incoming payload but matched
//     nothing is a stronger negative signal than never having had one, so the
//     name/slug tier only runs when the payload carried neither.

function normalizeMac(value) {
  return (value || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}

// Identity-key canonicalization: the first dot-label only. Deliberately
// narrow -- this decides whether two discovery payloads describe the same
// device, not whether a human would consider two names "close enough".
//
// Do not confuse with agent_binding.js's normalizeHost, which strips
// host-/lxc-/pve- prefixes and hex suffixes for fuzzy slug-candidate
// generation during agent adoption -- a different, looser operation for a
// different purpose. Keep the two separate; do not have one call the other.
function normalizeIdentityHost(value) {
  return (value || '').toLowerCase().split('.')[0].trim();
}

function macsOf(metadata) {
  const macs = [];
  if (!metadata) return macs;
  if (metadata.macAddress) macs.push(normalizeMac(metadata.macAddress));
  if (metadata.interfaces) {
    for (const i of metadata.interfaces) {
      const m = normalizeMac(i.mac);
      if (m.length === 12) macs.push(m);
    }
  }
  return [...new Set(macs.filter(m => m.length === 12))];
}

function ipsOf(metadata) {
  const ips = [];
  if (!metadata) return ips;
  if (metadata.interfaces) {
    for (const i of metadata.interfaces) if (i.ip) ips.push(i.ip);
  }
  if (metadata.ip) ips.push(metadata.ip);
  if (metadata.address) {
    for (const a of String(metadata.address).split(',')) {
      const trimmed = a.trim();
      if (trimmed) ips.push(trimmed);
    }
  }
  return [...new Set(ips.filter(Boolean))];
}

// A resource with its own MAC is a strong identity that a weaker IP/name
// guess can never overwrite.
function hasStrongIdentity(resource) {
  const md = resource && resource.metadata;
  return !!(md && (md.macAddress || (md.interfaces && md.interfaces.some(i => i.mac))));
}

function matchByMac(macs, pool) {
  if (!macs.length) return null;
  return pool.find(r => r.metadata && (
    (r.metadata.macAddress && macs.includes(normalizeMac(r.metadata.macAddress))) ||
    (r.metadata.interfaces && r.metadata.interfaces.some(i => macs.includes(normalizeMac(i.mac))))
  )) || null;
}

function matchByIp(ips, pool, { siteOf, incomingSiteId } = {}) {
  if (!ips.length) return null;
  return pool.find(r => {
    if (hasStrongIdentity(r)) return false;
    if (incomingSiteId && siteOf && siteOf(r.id) !== incomingSiteId) return false;
    if (!r.metadata) return false;
    if (r.metadata.ip && ips.includes(r.metadata.ip)) return true;
    if (r.metadata.address) {
      const addrs = String(r.metadata.address).split(',').map(a => a.trim());
      if (addrs.some(a => ips.includes(a))) return true;
    }
    if (r.metadata.interfaces && r.metadata.interfaces.some(i => ips.includes(i.ip))) return true;
    return false;
  }) || null;
}

function matchByNameOrSlug(name, slug, pool, { siteOf, incomingSiteId } = {}) {
  if (!name && !slug) return null;
  const inputName = normalizeIdentityHost(name || slug);
  return pool.find(r => {
    if (hasStrongIdentity(r)) return false;
    if (incomingSiteId && siteOf && siteOf(r.id) !== incomingSiteId) return false;
    if (slug && r.slug === slug) return true;
    if (name && r.name && r.name.toLowerCase() === name.toLowerCase()) return true;
    if (inputName && r.name && normalizeIdentityHost(r.name) === inputName) return true;
    if (inputName && r.slug && normalizeIdentityHost(r.slug) === inputName) return true;
    return false;
  }) || null;
}

// Run all four tiers, in order, against a pool the caller has already scoped
// (e.g. by identity class). `incoming` is { id, name, slug, metadata }.
// `opts.siteOf` (a function id -> siteId|null) and `opts.incomingSiteId`
// scope only the ip and name/slug tiers.
function findExistingMatch(incoming, pool, opts = {}) {
  if (incoming.id) {
    const byId = pool.find(r => r.id === incoming.id);
    if (byId) return byId;
  }

  const macs = macsOf(incoming.metadata);
  if (macs.length) {
    const byMac = matchByMac(macs, pool);
    if (byMac) return byMac;
  }

  const ips = ipsOf(incoming.metadata);
  if (ips.length) {
    const byIp = matchByIp(ips, pool, opts);
    if (byIp) return byIp;
  }

  // A MAC or IP present in the incoming payload but unmatched must not fall
  // through to a fuzzy name guess -- see file header.
  if (macs.length || ips.length) return null;

  return matchByNameOrSlug(incoming.name, incoming.slug, pool, opts);
}

module.exports = {
  normalizeMac,
  normalizeIdentityHost,
  macsOf,
  ipsOf,
  hasStrongIdentity,
  matchByMac,
  matchByIp,
  matchByNameOrSlug,
  findExistingMatch
};
