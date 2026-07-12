'use strict';

const conf = require('@simpleworkjs/conf');
const {setUpTable} = require('model-redis');

const Table = setUpTable(conf.redis);

module.exports = Table;

require('./token');
require('./verification');
require('./oauth_client');
require('./oauth_code');
require('./api_token');
