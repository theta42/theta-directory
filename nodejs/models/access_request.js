'use strict';

// Self-service access requests: the "request" half of the directory catalog.
//
// A request is a *proposal to join an LDAP group*. Approving one does exactly
// what an admin would have done by hand -- add the user to `groupCn` -- so LDAP
// remains the single access-control truth and this table is only the paper
// trail of who asked, who decided, and when. Nothing here grants anything on
// its own; a row with status 'approved' whose LDAP write failed is a row that
// grants no access, which is the safe direction.

const { Model } = require('@simpleworkjs/orm');

const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  CANCELLED: 'cancelled',
};

class AccessRequest extends Model {
  static fields = {
    id: { type: 'uuid', primaryKey: true },
    // The requesting user's uid (not dn): dn changes if the directory is
    // restructured, uid is the stable handle used everywhere else in the app.
    uid: { type: 'string', isRequired: true },
    resource: { type: 'hasOne', model: 'Resource' }, // creates resourceId
    // The group joining which satisfies this request. Captured at request time
    // so a later re-link of the resource's groups can't silently redirect a
    // pending approval at a different group than the one that was reviewed.
    groupCn: { type: 'string', isRequired: true },
    status: { type: 'string', isRequired: true, default: STATUS.PENDING },
    note: { type: 'text' },
    requestedOn: { type: 'integer' },
    decidedBy: { type: 'string' },
    decidedOn: { type: 'integer' },
    decisionNote: { type: 'text' },
  };

  // The one request that blocks a new one: same user, same group, still open.
  // Denied/cancelled requests deliberately do not block -- circumstances change
  // and a user may ask again.
  static async findOpen(uid, groupCn) {
    const rows = await this.list({ where: { uid, groupCn, status: STATUS.PENDING } });
    return rows[0] || null;
  }

  static async listForUser(uid) {
    return this.list({ where: { uid } });
  }

  static async listPending() {
    return this.list({ where: { status: STATUS.PENDING } });
  }
}

module.exports = { AccessRequest, STATUS };
