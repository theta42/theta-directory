'use strict';

// Persisted multi-site role (MULTI_SITE_SPEC.md). Whether this node is the
// master authority, which site it belongs to, and the master it replicates
// from live in /config/site.json so they survive restarts (the old code kept
// them in Node memory, so a container recreate silently reverted a spoke back
// to "master").
//
// Boot-time defaults come from the environment (IS_MASTER / MASTER_URL /
// SITE_SLUG, which docker-compose passes); a written site.json overrides for
// the life of the deployment. site-promote and the site-join flow both write
// here.

const fs = require('fs');
const path = require('path');

// Overridable so tests can point at a temp file instead of /config/site.json.
function configFile() {
  return process.env.SITE_CONFIG_FILE || '/config/site.json';
}

function envDefaults() {
  return {
    isMaster: process.env.IS_MASTER ? process.env.IS_MASTER === 'true' : true,
    masterUrl: process.env.MASTER_URL || '',
    siteSlug: process.env.SITE_SLUG || 'site-default',
    wanConnected: true
  };
}

let current = null;

function load() {
  const env = envDefaults();
  const file = configFile();
  try {
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...env, ...saved };
    }
  } catch (e) {
    console.error('[site] could not read ' + file + ': ' + e.message);
  }
  return env;
}

// get returns the current site config.
function get() {
  if (!current) current = load();
  return { ...current };
}

// save merges a patch and persists it to the site config file.
function save(patch) {
  current = { ...get(), ...patch };
  const file = configFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
  } catch (e) {
    console.error('[site] could not write ' + file + ': ' + e.message);
    throw e;
  }
  return get();
}

module.exports = { get, save, configFile };
