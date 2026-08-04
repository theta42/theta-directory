'use strict';

// SharedSecretGrant — who can read a shared secret. Each row says "grantee
// <granteeId> (a user uid or an app name) has <capability> on the shared secret
// <secretId>".
//
// This table is the metadata/UX record of a grant. The actual ENFORCEMENT lives
// in OpenBao ACL policy content: when a grant is created, vault_broker.js
// recomputes the grantee's policy HCL (`user-<uid>` or `app-<name>`) to include
// `read` on the exact shared path and rewrites it. Because OpenBao parses policy
// content live at token use, the grant applies to the grantee's existing token
// immediately (no re-mint). Revoking removes the rule and rewrites the policy.
//
// granteeType distinguishes the two principal kinds:
//   'user' — a user uid → grantee's `user-<uid>` policy is edited
//   'app'  — an app name → grantee's `app-<name>` policy is edited (downstream apps)
// capability is currently always 'read' (grantees are read-only); the column is
// a string so later capabilities could be added without a migration.
//
// No ORM auto-timestamp hook: route handlers stamp created_by/on + updated_by/on.
// Uniqueness on (secretId, granteeType, granteeId) prevents duplicate grants.

const { Model } = require('@simpleworkjs/orm');

const GRANTEE_TYPES = ['user', 'app'];
const CAPABILITIES = ['read'];

class SharedSecretGrant extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    // FK to SharedSecret.id.
    secretId: { type: 'string', isRequired: true, min: 1 },
    // 'user' (a uid) or 'app' (an app name) — which policy to edit.
    granteeType: { type: 'string', isRequired: true, min: 1 },
    // The grantee's uid (for 'user') or app name (for 'app').
    granteeId: { type: 'string', isRequired: true, min: 1, max: 64 },
    // Access level — 'read' today.
    capability: { type: 'string', isRequired: true, default: 'read' },
    // Audit stamps (set by the route handler, not by an ORM hook).
    created_by: { type: 'string' },
    created_on: { type: 'integer' },
    updated_by: { type: 'string' },
    updated_on: { type: 'integer' },
  };

  // All grants for a given grantee (user uid or app name). Used to rebuild the
  // grantee's policy content so every granted shared path is present/absent.
  static async listForGrantee(granteeType, granteeId) {
    return this.list({ where: { granteeType, granteeId } });
  }
}

module.exports = { SharedSecretGrant, GRANTEE_TYPES, CAPABILITIES };
