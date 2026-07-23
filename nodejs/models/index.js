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
        Resource, ResourceEdge, ResourceGroup,
        Token, AuthToken, InviteToken, ImpersonationToken, PasswordResetToken, OtpToken, ServiceToken
      ]
    });
    console.log('[initORM] ORM initialized successfully');
    console.log('[initORM] Resource.orm =', !!Resource.orm, 'Token.orm =', !!Token.orm);
  } catch (err) {
    console.error('[initORM] ORM initialization failed:', err.message);
    throw err;
  }
}

module.exports.initORM = initORM;
