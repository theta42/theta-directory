const express = require('express');

// Parses arguments according to the exposed method config.
// Extended to support { from: 'user' } which injects `req.user.dn` (LDAP integration).
function extractArgs(req, cfg) {
  const args = cfg.args;
  if (!args) return [];
  if (args.from === 'user') return [req.user.dn];
  
  const source = args.from === 'params' ? req.params
    : args.from === 'query' ? req.query
      : req.body;
      
  if (Array.isArray(args.names)) return args.names.map(name => source[name]);
  return [source || {}];
}

// A mini-auto-router that reads `static exposedMethods` from a @simpleworkjs/orm Model
// and maps them directly into Express endpoints.
function autoRouter(Model) {
  const router = express.Router();

  if (Model.getExposedMethods) {
    for (const cfg of Model.getExposedMethods()) {
      router[cfg.verb](cfg.routePath, async function(req, res, next) {
        try {
          // In a full implementation, we'd load the instance if cfg.kind === 'instance'.
          // For now, our methods are all static class methods.
          const target = Model;
          const result = await target[cfg.method](...extractArgs(req, cfg));
          res.json(result);
        } catch (error) {
          next(error);
        }
      });
    }
  }
  
  return router;
}

module.exports = autoRouter;
