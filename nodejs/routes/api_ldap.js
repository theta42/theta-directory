'use strict';

// LDAP-over-HTTPS API (DESIGN.md §3).
//
// The whole point of this API is that a client stops speaking LDAP and instead
// does an HTTPS call to the SSO, where the directory is reachable. That kills
// the hostname / cross-network / LDAPS-cert-chain pain: no LDAP protocol, no
// cert to trust, no firewall rule.
//
//   POST /api/v1/ldap/bind    {username, password} -> 200 {dn, uid} | 401
//   POST /api/v1/ldap/search  {base_dn, scope, filter, attributes} -> 200 {entries}
//
// Caller auth: a Bearer token in the Authorization header. Two kinds of caller
// are accepted, reusing existing credentials:
//   - an agent token (the same one the agent presents on its WSS channel) — the
//     caller is a node acting for SSSD;
//   - a self-service API token (PAT, `sso_...`) — the caller is a user/app.
// The API authorizes the *caller*; OpenLDAP enforces the actual directory ACLs.
//
// Security note on /search: it runs under the directory admin bind (withClient),
// so it can read the whole tree. It is therefore restricted to agent callers
// (the SSSD user/group-resolution use case) and must eventually move to a
// scoped read-only service account rather than the admin bind. See DESIGN.md §9.

const express = require('express');
const { createLdapClient } = require('@simpleworkjs/ldap');
const conf = require('@simpleworkjs/conf').ldap;
const { Agent } = require('../models/agent');
const { ApiToken } = require('../models/api_token');

const router = express.Router();
const ldap = createLdapClient(conf);

// Resolve a Bearer token to a caller identity, or null. Tries the agent token
// first, then a PAT. Every failure collapses to null so a probing caller learns
// nothing about which credential was wrong.
async function authenticateCaller(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const token = String(m[1]).trim();
  if (!token) return null;

  try {
    const agent = await Agent.authenticate(token);
    if (agent) return { kind: 'agent', id: agent.id, name: agent.name };
  } catch (_) {}

  try {
    const pat = await ApiToken.authenticate(token);
    if (pat) return { kind: 'user', id: pat.created_by };
  } catch (_) {}

  return null;
}

// POST /bind — authenticate a username/password against the directory.
router.post('/bind', async (req, res, next) => {
  try {
    const caller = await authenticateCaller(req);
    if (!caller) return res.status(401).json({ status: 'error', message: 'unauthorized' });

    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ status: 'error', message: 'username and password are required' });
    }

    // Resolve the username to a DN, then simple-bind as that DN. A missing user
    // and a wrong password both surface as 401 (no user-existence oracle).
    const user = await ldap.getUser(String(username));
    if (!user) return res.status(401).json({ status: 'error', message: 'invalid credentials' });

    const ok = await ldap.checkPassword(user.dn, String(password));
    if (!ok) return res.status(401).json({ status: 'error', message: 'invalid credentials' });

    return res.json({ status: 'ok', dn: user.dn, uid: user.uid });
  } catch (err) { next(err); }
});

// POST /search — run a directory search. Agent callers only (see header note).
router.post('/search', async (req, res, next) => {
  try {
    const caller = await authenticateCaller(req);
    if (!caller) return res.status(401).json({ status: 'error', message: 'unauthorized' });
    if (caller.kind !== 'agent') {
      return res.status(403).json({ status: 'error', message: 'search is restricted to agents' });
    }

    const { base_dn, scope, filter, attributes } = req.body || {};
    if (!filter) return res.status(400).json({ status: 'error', message: 'filter is required' });

    const entries = await ldap.withClient(async (client) => {
      const { searchEntries } = await client.search(base_dn || conf.userBase, {
        scope: scope || 'sub',
        filter: String(filter),
        attributes: Array.isArray(attributes) && attributes.length ? attributes : undefined,
      });
      return searchEntries;
    });

    return res.json({ status: 'ok', entries });
  } catch (err) { next(err); }
});

module.exports = router;
