const {setUpTable} = require('model-redis');
const redis = require('redis');
const client = redis.createClient();
const Table = setUpTable(client, 'prefix_');
Table._keyMap = { token: { type: 'string' } };
Table._key = 'token';
Table.register(Table);
const inst = new Table({token: '123'});
console.log(typeof inst.del);
