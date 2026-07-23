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
const { RedisAdapter } = require('@simpleworkjs/orm/lib/adapters/redis');

// Monkey-patch ORM bugs in RedisAdapter
RedisAdapter.prototype.delete = async function(instance) {
  await instance._backing.remove();
};
RedisAdapter.prototype.update = async function(instance, data) {
  await instance._backing.update(data);
  return instance;
};

const { Resource, ResourceEdge, ResourceGroup } = require('./resource');

async function initORM() {
  const ormConf = conf.orm || {
    dialect: 'sqlite',
    storage: './config/inventory.sqlite',
    logging: false
  };
  ormConf.redis = conf.redis;

  await init({
    conf: { orm: ormConf },
    models: [
      Resource, ResourceEdge, ResourceGroup,
      Token, AuthToken, InviteToken, ImpersonationToken, PasswordResetToken, OtpToken, ServiceToken
    ]
  });
}

module.exports.initORM = initORM;
