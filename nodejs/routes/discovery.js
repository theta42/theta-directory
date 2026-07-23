const autoRouter = require('./autoRouter');
const { Resource } = require('../models/resource');

module.exports = autoRouter(Resource);
