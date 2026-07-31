'use strict';

// Resolve a request user's LDAP group CNs.
//
// Why this exists: `req.user` is a `User.get()` result, which carries
// `memberOf` -- a list of full group DNs -- and has no `groups` property at
// all. Anything reading `req.user.groups` therefore silently sees an empty
// list rather than failing, which is how GET /api/discovery/me came to return
// only `isPublic` resources for every human caller, and how
// isDirectoryAdmin() came to be false even for real directory admins.
//
// routes/user.js:83 already derives the admin gate from `memberOf` the same
// way, so the overlay is known to be populated in production; the Group.list()
// fallback covers a user object assembled without it (and costs an LDAP round
// trip, so it is genuinely the fallback).

const { Group } = require('../models/group_ldap');

// 'cn=app_sso_admin,ou=groups,dc=example,dc=com' -> 'app_sso_admin'
function cnFromDn(dn) {
  return String(dn).split(',')[0].replace(/^cn=/i, '');
}

async function groupCns(user) {
  if (!user || user.isMachine) return [];

  // Group.list(dn) resolves nested groups transitively. `memberOf` cannot: the
  // memberof overlay records only direct membership, so a user who reaches a
  // resource group through a nested group is absent from it entirely. That
  // makes memberOf a fallback for when there is no DN to query with, never the
  // preferred source -- reading it first would silently drop every nested grant.
  if (user.dn) {
    try {
      return await Group.list(user.dn);
    } catch (err) {
      console.error(`groupCns: LDAP lookup failed for ${user.uid}:`, err.message);
    }
  }

  if (Array.isArray(user.memberOf)) return user.memberOf.map(cnFromDn);
  // memberOf is single-valued when the user is in exactly one group.
  if (user.memberOf) return [cnFromDn(user.memberOf)];

  return [];
}

// The shape @simpleworkjs/directory-schema's isDirectoryAdmin() expects: it
// matches against `.groups`, which the raw request user does not have.
async function withGroups(user) {
  if (!user) return user;
  return Object.assign(Object.create(Object.getPrototypeOf(user) || Object.prototype), user, {
    groups: await groupCns(user),
  });
}

module.exports = { groupCns, withGroups, cnFromDn };
