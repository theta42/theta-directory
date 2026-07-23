const { hashPasswordSSHA512 } = require('./nodejs/models/user_ldap.js');
console.log(hashPasswordSSHA512('MyTestPassword!2'));
