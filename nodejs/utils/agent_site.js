'use strict';

// "Which site is this machine at?" -- one answer, shared by the agent
// websocket join handler and by discovery reconciliation, so an agent cannot
// enrol into one site and then have its telemetry filed under another.
//
// The hint travels from the agent itself. theta-agent resolves it, in order:
//   1. `location` in agent.yml -- an operator said so explicitly.
//   2. mDNS: the `site` TXT field of a `_theta-suite._tcp` announcement that
//      fronts the very host the agent is configured to talk to.
//   3. nothing, and the server falls back to its own current site.
//
// The mDNS hint is a LABEL, never a credential. It decides which row a host is
// filed under, and nothing else -- the join key and TLS decide whether the
// agent is allowed in at all. A spoofed announcement can at worst put a host
// in the wrong site of a directory that already accepted its join key.

// Exact match only. Fuzzy site matching is how resources ended up in the wrong
// site to begin with, so an unrecognised hint is an error the caller reports,
// never something to guess past.
async function resolveSiteHint(hint) {
  const wanted = String(hint || '').trim();
  if (!wanted) return null;

  const { Resource } = require('../models/resource');
  const sites = await Resource.list({ where: { kind: 'site' } }).catch(() => []);
  return sites.find(s =>
    s.id === wanted ||
    s.slug === wanted ||
    s.slug === `site_${wanted}` ||
    s.slug === `site-${wanted}` ||
    s.name === wanted
  ) || null;
}

// The site this directory itself is. Set on exactly one row (see
// utils/site_join.js, which is careful to keep a spoke's own row flagged).
async function currentSite() {
  const { Resource } = require('../models/resource');
  const sites = await Resource.list({ where: { kind: 'site' } }).catch(() => []);
  return sites.find(s => s.metadata && s.metadata.isCurrentSite) || null;
}

// The site to file an agent's host under. Returns null when nothing matched,
// which callers must treat as "do not file it anywhere" -- never as "use the
// first site you can find".
async function resolveAgentSite({ location, public_ip: publicIp } = {}) {
  if (location && location !== 'default') {
    const byHint = await resolveSiteHint(location);
    if (byHint) return byHint;
    console.warn(`[agent-site] agent reported location "${location}", which matches no site row`);
  }

  if (publicIp) {
    const { Resource } = require('../models/resource');
    const sites = await Resource.list({ where: { kind: 'site' } }).catch(() => []);
    const byIp = sites.find(s => {
      const siteIp = (s.metadata?.public_ip || s.metadata?.ip || s.metadata?.address || '').trim();
      return siteIp && (siteIp === publicIp || siteIp.includes(publicIp));
    });
    if (byIp) return byIp;
  }

  // The directory the agent connected to is itself at a site, and that is a
  // real answer rather than a guess -- unlike picking sites[0], which on a
  // master holding every spoke's row is arbitrary.
  return currentSite();
}

module.exports = { resolveSiteHint, currentSite, resolveAgentSite };
