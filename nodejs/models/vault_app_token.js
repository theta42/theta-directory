'use strict';

// VaultAppToken — the ACCESSOR of an OpenBao token minted for an external app
// from the vault UI (Apps tab), so sso can keep the token alive.
//
// The token itself is shown ONCE at mint and never stored (a stolen accessor
// cannot authenticate — it can only look up, renew, or revoke its token, and
// only the sso broker's policy grants those endpoints). App tokens are minted
// through the sso-app role as PERIODIC tokens: they live forever, but only if
// something renews them inside every period window. That something is sso's
// renewal loop (vault_broker.startAppTokenRenewal), which walks these rows and
// POSTs auth/token/renew-accessor on a timer — so a downstream app's credential
// stays valid as long as sso itself is running, with no renewal code needed in
// the downstream app.
//
// One row per app name: re-minting an app's token revokes the previous token
// via its accessor (no zombie credentials) and replaces the row.

const { Model } = require('@simpleworkjs/orm');

class VaultAppToken extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    // The external app's name — also its policy (app-<name>) and KV namespace
    // (secret/apps/<name>/). Unique: one live token per app.
    name: { type: 'string', isRequired: true, unique: true, min: 1, max: 64 },
    // The minted token's accessor (renew/revoke handle, cannot authenticate).
    accessor: { type: 'string', isRequired: true, max: 128 },
    // Renewal bookkeeping, updated by the renewal loop.
    lastRenewedAt: { type: 'integer' },
    lastError: { type: 'text' },
    // Audit stamps (set by the route handler, not by an ORM hook).
    created_by: { type: 'string' },
    created_on: { type: 'integer' },
  };

  static async getByName(name) {
    const rows = await this.list({ where: { name } });
    return rows[0] || null;
  }
}

module.exports = { VaultAppToken };
