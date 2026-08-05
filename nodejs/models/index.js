'use strict';

const conf = require('@simpleworkjs/conf');
const { setUpTable } = require('model-redis');

// Keep model-redis for the ones not yet ported
const Table = setUpTable(conf.redis);
module.exports = Table;

const { Token, AuthToken, InviteToken, ImpersonationToken, PasswordResetToken, OtpToken, ServiceToken } = require('./token');
require('./verification');
require('./oauth_code');
require('./api_token');

const { init } = require('@simpleworkjs/orm');
const { Resource, ResourceEdge, ResourceGroup } = require('./resource');
const { AccessRequest } = require('./access_request');
const { Webhook } = require('./webhook');
const { PluginInstance } = require('./plugin_instance');
const { SharedSecret } = require('./shared_secret');
const { SharedSecretGrant } = require('./shared_secret_grant');
const { VaultAppToken } = require('./vault_app_token');
const { Agent } = require('./agent');
async function initORM() {
  const ormConf = conf.orm || {
    dialect: 'sqlite',
    storage: './config/inventory.sqlite',
    logging: false
  };
  ormConf.redis = conf.redis;

  console.log('[initORM] Starting ORM initialization...');
  try {
    await init({
      conf: { orm: ormConf },
      models: [
        Resource, ResourceEdge, ResourceGroup, AccessRequest, Webhook, PluginInstance,
        SharedSecret, SharedSecretGrant, VaultAppToken, Agent,
        Token, AuthToken, InviteToken, ImpersonationToken, PasswordResetToken, OtpToken, ServiceToken
      ]
    });
    console.log('[initORM] ORM initialized successfully');
    console.log('[initORM] Resource.orm =', !!Resource.orm, 'Token.orm =', !!Token.orm);
    await healSchema();
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

module.exports.initORM = initORM;
