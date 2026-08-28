'use strict';

const conf = require('@simpleworkjs/conf');
const { setUpTable } = require('model-redis');

// Keep model-redis for the ones not yet ported
const Table = setUpTable(conf.redis);
module.exports = Table;

const { Token, AuthToken, InviteToken, ImpersonationToken, PasswordResetToken, OtpToken, ServiceToken } = require('./token');
require('./verification');
require('./activity_event');   // notification history (shape only, TTL-bounded)
require('./activity_seen');    // per-user read watermark
require('./oauth_code');
const { ApiToken, migrateFromRedis: migrateApiTokensFromRedis } = require('./api_token');

const { init } = require('@simpleworkjs/orm');
const socketPubsub = require('../utils/socket_pubsub');
const modelEvents = require('../utils/model_events');
const { Resource, ResourceEdge, ResourceGroup } = require('./resource');
const { AccessRequest } = require('./access_request');
const { Webhook } = require('./webhook');
const { PluginInstance } = require('./plugin_instance');
const { SharedSecret } = require('./shared_secret');
const { SharedSecretGrant } = require('./shared_secret_grant');
const { VaultAppToken } = require('./vault_app_token');
const { Agent, AgentJoinKey } = require('./agent');
const { SiteJoinKey } = require('./site_join_key');
const { SiteSpoke } = require('./site_spoke');
const { MeshSite } = require('./mesh_site');
const { MeshClient, MeshExitGrant } = require('./mesh_client');
const { SubtypeTemplate } = require('./subtype_template');

async function initORM() {
  const ormConf = conf.orm || {
    dialect: 'sqlite',
    storage: './config/inventory.sqlite',
    logging: false
  };
  ormConf.redis = conf.redis;

  // One bus for every model, ORM-managed or not: the ORM publishes through it
  // directly, and utils/model_events routes the LDAP- and Redis-backed models
  // through the same filter (see utils/socket_pubsub.liveBus).
  const liveBus = socketPubsub.liveBus(require('../controller').ps);
  modelEvents.bind(liveBus);

  console.log('[initORM] Starting ORM initialization...');
  try {
    // `pubsub` makes every model publish model:<Name>:<action> on save/delete,
    // which is what the browser's app.sync layer consumes. It is wrapped so
    // only the models that have a socket read gate are forwarded onto the bus:
    // the ORM publishes for everything it loads, and that includes AuthToken /
    // OtpToken / PasswordResetToken, written on every login and password reset.
    await init({
      conf: { orm: ormConf },
      pubsub: liveBus,
      models: [
        Resource, ResourceEdge, ResourceGroup, AccessRequest, Webhook, PluginInstance,
        SharedSecret, SharedSecretGrant, VaultAppToken, Agent, AgentJoinKey, SiteJoinKey, SiteSpoke,
        MeshSite, MeshClient, MeshExitGrant, SubtypeTemplate,
        Token, AuthToken, InviteToken, ImpersonationToken, PasswordResetToken, OtpToken, ServiceToken,
        ApiToken
      ]
    });
    console.log('[initORM] ORM initialized successfully');
    console.log('[initORM] Resource.orm =', !!Resource.orm, 'Token.orm =', !!Token.orm);
    const adapter = Resource.orm && Resource.orm.adapters && Resource.orm.adapters.sequelize;
    if (adapter && adapter.sequelize && adapter.sequelize.getDialect() === 'sqlite') {
      try {
        await adapter.sequelize.query('PRAGMA journal_mode = WAL;');
        await adapter.sequelize.query('PRAGMA busy_timeout = 10000;');
        await adapter.sequelize.query('PRAGMA synchronous = NORMAL;');
      } catch (e) {
        console.warn('[initORM] failed to set SQLite PRAGMAs:', e.message);
      }
    }
    await healSchema();
    await ensureUniqueIndexes();
    // Migrate PATs from Redis (pre-v2.24.8 store) into the replicated SQLite
    // catalog. Best-effort and idempotent; safe to leave in place forever.
    try {
      await migrateApiTokensFromRedis(Table);
    } catch (e) {
      console.warn('[initORM] ApiToken migration failed:', e.message);
    }
  } catch (err) {
    console.error('[initORM] ORM initialization failed:', err.message);
    throw err;
  }
}

// Add-only schema heal. @simpleworkjs/orm runs sequelize.sync() WITHOUT alter,
// which creates missing tables but never touches existing ones — so a column
// added in a newer release (e.g. PluginInstance.lastLog) simply never appears
// in an upgraded deployment's database and every query on the model fails
// ("no such column"). This walks each Sequelize model and ADDs any attribute
// missing from its table. Strictly additive (never drops or retypes), works on
// any dialect via the query interface, and fail-soft per column so one bad
// attribute can't take the boot down.
async function healSchema() {
  const adapter = Resource.orm && Resource.orm.adapters && Resource.orm.adapters.sequelize;
  if (!adapter || !adapter.sequelize) return;
  const sequelize = adapter.sequelize;
  const qi = sequelize.getQueryInterface();
  for (const SM of Object.values(sequelize.models)) {
    const table = SM.getTableName();
    let existing;
    try { existing = await qi.describeTable(table); }
    catch (e) { continue; } // no table yet — sync() handles creation
    for (const [name, attr] of Object.entries(SM.getAttributes())) {
      const col = attr.field || name;
      if (existing[col]) continue;
      try {
        await qi.addColumn(table, col, attr);
        console.log(`[initORM] schema heal: added missing column ${table}.${col}`);
      } catch (e) {
        console.error(`[initORM] schema heal: could not add ${table}.${col}:`, e.message);
      }
    }
  }
}

// Unique indexes the model layer cannot give us.
//
// Two independent gaps make `unique: true` in a model's `fields` a no-op here:
//
//   1. @simpleworkjs/orm only forwards `unique` for string fields —
//      IntegerField.toSequelize() drops it (lib/fields.js). So it can never
//      reach the database for an integer column like SiteSpoke.ldapServerId.
//   2. The ORM calls sequelize.sync() with no options (lib/orm.js), which
//      creates missing TABLES but never alters existing ones — the same reason
//      healSchema() above exists. Every already-deployed site therefore lacks
//      even SiteSpoke.endpoint's declared unique constraint.
//
// So the indexes are added here explicitly, on the same add-only, fail-soft
// terms as healSchema: never drop, never retype, never take the boot down.
//
// ldapServerId is the one that matters. It is allocated read-then-write
// (routes/api_site.js), serialized by an in-process mutex — which protects
// nothing if the app is ever run as more than one process against one
// database. Duplicate ServerIDs do not error; they quietly break OpenLDAP
// multi-master replication, because ServerID is how syncrepl tells originators
// apart. The index is what makes that a hard failure instead of a silent one.
async function ensureUniqueIndexes() {
  const adapter = Resource.orm && Resource.orm.adapters && Resource.orm.adapters.sequelize;
  if (!adapter || !adapter.sequelize) return;
  const qi = adapter.sequelize.getQueryInterface();

  await repairDuplicateServerIds();
  await openExistingSiteExits();

  const wanted = [
    { model: 'SiteSpoke', field: 'ldapServerId', name: 'site_spoke_ldap_server_id_unique' },
    { model: 'SiteSpoke', field: 'endpoint', name: 'site_spoke_endpoint_unique' }
  ];

  for (const { model, field, name } of wanted) {
    const SM = adapter.sequelize.models[model];
    if (!SM) continue;
    // The table name comes from the model, not a literal: the adapter sets
    // tableName from the class name (lib/adapters/sequelize.js), which is not
    // the pluralized name Sequelize would pick on its own.
    const table = SM.getTableName();
    const attr = SM.getAttributes()[field];
    const column = (attr && attr.field) || field;
    try {
      const existing = await qi.showIndex(table);
      if (existing.some((i) => i.name === name)) continue;
      await qi.addIndex(table, { fields: [column], unique: true, name });
      console.log(`[initORM] added unique index ${name}`);
    } catch (e) {
      // Almost always "this database already contains duplicates" — which is
      // the corruption the index exists to prevent, and which an operator has
      // to resolve. Say so loudly rather than booting as if it were enforced.
      console.error(`[initORM] could not add unique index ${name}: ${e.message}`);
    }
  }
}

// A database written before the index existed may already hold the bug. NULL
// ids are left alone (a spoke that has not been assigned one yet); among real
// duplicates the oldest registration keeps the id and the rest are moved to
// free ones. Reassignment is safe to do unattended because a spoke does not
// store its own ServerID authoritatively — it re-reads it from the master via
// GET /api/site/ldap-peers on every reconcile (utils/ldap_reconcile.js) — and
// the duplicate state is already broken, so leaving it is not the safer option.
async function repairDuplicateServerIds() {
  let rows;
  try { rows = await SiteSpoke.list(); }
  catch (e) { return; } // table not present yet

  const byId = new Map();
  for (const row of rows || []) {
    if (!row.ldapServerId) continue;
    if (!byId.has(row.ldapServerId)) byId.set(row.ldapServerId, []);
    byId.get(row.ldapServerId).push(row);
  }

  const used = new Set(byId.keys());
  used.add(1); // reserved for the master, never handed to a spoke

  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    // Oldest keeps it; created_on can be unset on hand-me-down rows, so fall
    // back to a stable order rather than an arbitrary one.
    group.sort((a, b) => (a.created_on || 0) - (b.created_on || 0) || String(a.id).localeCompare(String(b.id)));
    for (const row of group.slice(1)) {
      let next = 2;
      while (used.has(next)) next += 1;
      used.add(next);
      try {
        await row.update({ ldapServerId: next });
        console.error(
          `[initORM] duplicate LDAP ServerID ${id} on ${row.endpoint} — reassigned to ${next}. ` +
          'Replication for this site was broken until now; it re-reads its ID on the next reconcile.'
        );
      } catch (e) {
        console.error(`[initORM] could not reassign duplicate ServerID ${id} on ${row.endpoint}: ${e.message}`);
      }
    }
  }
}

module.exports.initORM = initORM;
module.exports.ensureUniqueIndexes = ensureUniqueIndexes;
// One-time backfill for the exitOpen default flip (MeshSite.exitOpen went
// false -> true).
//
// A model default only applies to rows created afterwards, so an upgraded
// deployment would keep every existing site closed and still have no usable
// exit anywhere -- the exact problem the flip was meant to fix. This opens the
// sites that predate it.
//
// Guarded by a marker in the site config so it runs EXACTLY once: an operator
// who later closes a site (a metered link, say) must not have it silently
// reopened on the next restart. Fail-soft, like the other boot repairs.
async function openExistingSiteExits() {
  const siteConfig = require('../utils/site_config');
  try {
    if (siteConfig.get().meshExitsOpened) return;
  } catch (_) { return; }

  let rows;
  try { rows = await MeshSite.list(); }
  catch (e) { return; } // table not present yet

  let opened = 0;
  for (const row of rows || []) {
    if (row.exitOpen) continue;
    try {
      await row.update({ exitOpen: true });
      opened += 1;
    } catch (e) {
      console.warn(`[initORM] could not open the exit on site ${row.siteId}: ${e.message}`);
    }
  }

  try {
    siteConfig.save({ meshExitsOpened: true });
  } catch (e) {
    // Without the marker this would run again next boot and reopen a site the
    // operator had closed, so say so loudly rather than leaving it silent.
    console.warn(`[initORM] opened ${opened} site exit(s) but could not record the marker: ${e.message}`);
    return;
  }
  if (opened) {
    console.log(`[initORM] every site now offers an internet exit (${opened} pre-existing site(s) opened).`);
  }
}

module.exports.repairDuplicateServerIds = repairDuplicateServerIds;
