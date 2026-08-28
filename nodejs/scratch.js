const { FilterParser } = require('ldapts');
const filter = FilterParser.parseString('(&(objectClass=posixAccount)(memberOf=cn=host-123_access))');
console.log(JSON.stringify(filter, null, 2));
