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
let loadedMtimeMs = 0;

function load() {
  const env = envDefaults();
  const file = configFile();
  try {
    if (fs.existsSync(file)) {
      loadedMtimeMs = fs.statSync(file).mtimeMs;
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...env, ...saved };
    }
  } catch (e) {
    console.error('[site] could not read ' + file + ': ' + e.message);
  }
  loadedMtimeMs = 0;
  return env;
}

// True when site.json changed underneath us.
//
// This file is not written only by this process: theta-suite's
// bootstrap/site-join.js runs as a separate `docker compose exec` and writes it
// directly on its already-joined / already-has-users paths. With a
// write-once-then-cache-forever read, the running app kept serving `isMaster:
// true` after such a run -- so it behaved as a master (accepting local
// directory writes, refusing resync pushes) until someone restarted the
// container. Cheap to check: one stat, and only on the boundary where it
// matters.
function fileChanged() {
  try {
    const st = fs.statSync(configFile());
    return st.mtimeMs !== loadedMtimeMs;
  } catch (e) {
    // Gone (or never existed): only a change if we had loaded one before.
    return loadedMtimeMs !== 0;
  }
}

// get returns the current site config.
function get() {
  if (!current || fileChanged()) current = load();
  return { ...current };
}

// save merges a patch and persists it to the site config file.
function save(patch) {
  current = { ...get(), ...patch };
  const file = configFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(current, null, 2) + '\n');
    loadedMtimeMs = fs.statSync(file).mtimeMs;
  } catch (e) {
    console.error('[site] could not write ' + file + ': ' + e.message);
    throw e;
  }
  return { ...current };
}

module.exports = { get, save, configFile };
