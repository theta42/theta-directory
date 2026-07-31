'use strict';

// Self-service access requests. Mounted at /api/access-requests (app.js).
//
// The loop this closes: a user browses the catalog, finds something they cannot
// reach, asks for it; the resource's owner (or a directory admin) approves; the
// approval performs the LDAP group add. LDAP stays the access-control truth --
// this router never invents a permission, it only automates the group add an
// admin would otherwise do by hand, and records who decided.

const router = require('express').Router();
const { Resource, ResourceGroup } = require('../models/resource');
const { AccessRequest, STATUS } = require('../models/access_request');
const { Group } = require('../models/group_ldap');
const { User } = require('../models/user_ldap');
const { Mail } = require('../models/email');
const { groupCns } = require('../utils/user_groups');
const { envelope, projectResource } = require('@simpleworkjs/directory-schema');

const DIRECTORY_ADMIN_GROUPS = ['app_sso_directory_admin', 'app_sso_admin', 'app_super_admin'];

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// May `user` decide requests against `resource`? The resource's own owner is
// the primary approver -- that is the point of Resource.owner -- with directory
// admins as the catch-all so an unowned or orphaned resource is never stuck.
async function canDecide(user, resource, callerGroups) {
  if (resource && resource.owner && resource.owner === user.uid) return true;
  return callerGroups.some(g => DIRECTORY_ADMIN_GROUPS.includes(g));
}

// The group that satisfies a request for this resource. Prefers an explicit
// choice, else the `member`-level link (the "just let me use it" group) over an
// `owner`-level one -- requesting a resource should never silently escalate to
// its admin group.
async function resolveGroupCn(resourceId, requested) {
  const links = await ResourceGroup.list({ where: { resourceId } });
  if (!links.length) {
    throw httpError(409, 'This resource has no access group linked, so it cannot be requested.');
  }
  if (requested) {
    const match = links.find(l => l.groupCn === requested);
    if (!match) throw httpError(400, `"${requested}" is not an access group for this resource.`);
    return match.groupCn;
  }
  const member = links.find(l => l.accessLevel === 'member');
  return (member || links[0]).groupCn;
}

// Best-effort notification. A mail failure must never fail the request itself --
// the row is the source of truth and the approver can find it in the UI.
async function notify(uid, subject, message) {
  try {
    const user = await User.get({ uid });
    if (!user || !user.mail) return;
    await Mail.sendTemplate(user.mail, 'notification', {
      givenName: user.givenName || uid,
      subject,
      message,
    });
  } catch (err) {
    console.error(`access-request: notification to ${uid} failed:`, err.message);
  }
}

// POST /api/access-requests  { slug | resourceId, groupCn?, note? }
router.post('/', async (req, res, next) => {
  try {
    if (req.user.isMachine) throw httpError(403, 'Machine accounts cannot request access.');

    let resource;
    if (req.body.slug) {
      const found = await Resource.list({ where: { slug: req.body.slug } });
      resource = found[0];
    } else if (req.body.resourceId) {
      resource = await Resource.get(req.body.resourceId);
    }
    if (!resource) throw httpError(404, 'Resource not found');

    const md = resource.metadata || {};
    // Opt-out, not opt-in: everything in the catalog is requestable unless an
    // admin has explicitly marked it otherwise.
    if (md.requestable === false) {
      throw httpError(409, 'This resource is not available for self-service requests.');
    }

    const groupCn = await resolveGroupCn(resource.id, req.body.groupCn);

    const callerGroups = await groupCns(req.user);
    if (callerGroups.includes(groupCn)) {
      throw httpError(409, 'You already have access to this resource.');
    }

    const existing = await AccessRequest.findOpen(req.user.uid, groupCn);
    if (existing) throw httpError(409, 'You already have a pending request for this resource.');

    const request = await AccessRequest.create({
      uid: req.user.uid,
      resourceId: resource.id,
      groupCn,
      status: STATUS.PENDING,
      note: req.body.note || '',
      requestedOn: Date.now(),
    });

    if (resource.owner) {
      await notify(
        resource.owner,
        `Access request: ${resource.name}`,
        `<p><strong>${req.user.uid}</strong> has requested access to <strong>${resource.name}</strong> (group <code>${groupCn}</code>).</p>` +
        (req.body.note ? `<p>Their note: ${req.body.note}</p>` : '') +
        `<p>Review it on the Directory page.</p>`
      );
    }

    res.json(envelope(request));
  } catch (err) { next(err); }
});

// GET /api/access-requests/mine — the caller's own request history.
router.get('/mine', async (req, res, next) => {
  try {
    const rows = await AccessRequest.listForUser(req.user.uid);
    res.json(envelope(await decorate(rows)));
  } catch (err) { next(err); }
});

// GET /api/access-requests — pending requests the caller may decide.
router.get('/', async (req, res, next) => {
  try {
    const callerGroups = await groupCns(req.user);
    const isAdmin = callerGroups.some(g => DIRECTORY_ADMIN_GROUPS.includes(g));
    const pending = await AccessRequest.listPending();

    let visible = pending;
    if (!isAdmin) {
      // A plain resource owner sees only requests against resources they own.
      const owned = await Resource.list({ where: { owner: req.user.uid } });
      const ownedIds = new Set(owned.map(r => r.id));
      visible = pending.filter(r => ownedIds.has(r.resourceId));
    }
    res.json(envelope(await decorate(visible)));
  } catch (err) { next(err); }
});

// Attach the resource name/slug each row refers to. The UI needs it on every
// list and would otherwise issue one lookup per row.
async function decorate(rows) {
  if (!rows.length) return [];
  const resources = await Resource.list();
  const byId = new Map(resources.map(r => [r.id, r]));
  return rows.map(row => {
    const data = row.toJSON ? row.toJSON() : { ...row };
    const resource = byId.get(data.resourceId);
    data.resource = resource
      ? { id: resource.id, name: resource.name, slug: resource.slug, kind: resource.kind }
      : null;
    return data;
  });
}

// POST /api/access-requests/:id/approve  { decisionNote? }
router.post('/:id/approve', async (req, res, next) => {
  try {
    const request = await AccessRequest.get(req.params.id);
    if (!request) throw httpError(404, 'Request not found');
    if (request.status !== STATUS.PENDING) {
      throw httpError(409, `This request was already ${request.status}.`);
    }

    const resource = await Resource.get(request.resourceId);
    const callerGroups = await groupCns(req.user);
    if (!(await canDecide(req.user, resource, callerGroups))) {
      throw httpError(403, 'You do not have permission to decide this request.');
    }

    // The LDAP write happens FIRST and is allowed to throw. Marking a request
    // approved without the group add would show the user a grant they do not
    // actually have -- a pending row is recoverable, a lying one is not.
    const group = await Group.get(request.groupCn);
    const user = await User.get({ uid: request.uid });
    try {
      await group.addMember(user);
    } catch (err) {
      // "already a member" is the goal state, not a failure. This happens
      // routinely: groupOfNames requires at least one member, so creating a
      // resource seeds its auto-created groups with the creator's DN, and an
      // admin may also grant access by hand while a request sits pending.
      // Without this the request would 500 and stay pending forever.
      const alreadyMember = err.name === 'TypeOrValueExistsError' || err.code === 20;
      if (!alreadyMember) throw err;
    }
    User.clearCache(); // membership feeds cached isAdmin / group-gated nav

    const updated = await request.update({
      status: STATUS.APPROVED,
      decidedBy: req.user.uid,
      decidedOn: Date.now(),
      decisionNote: req.body.decisionNote || '',
    });

    await notify(
      request.uid,
      `Access approved: ${resource ? resource.name : request.groupCn}`,
      `<p>Your request for <strong>${resource ? resource.name : request.groupCn}</strong> was approved by ${req.user.uid}.</p>` +
      `<p>You may need to sign out and back in for the change to take effect everywhere.</p>`
    );

    res.json(envelope(updated));
  } catch (err) { next(err); }
});

// POST /api/access-requests/:id/deny  { decisionNote? }
router.post('/:id/deny', async (req, res, next) => {
  try {
    const request = await AccessRequest.get(req.params.id);
    if (!request) throw httpError(404, 'Request not found');
    if (request.status !== STATUS.PENDING) {
      throw httpError(409, `This request was already ${request.status}.`);
    }

    const resource = await Resource.get(request.resourceId);
    const callerGroups = await groupCns(req.user);
    if (!(await canDecide(req.user, resource, callerGroups))) {
      throw httpError(403, 'You do not have permission to decide this request.');
    }

    const updated = await request.update({
      status: STATUS.DENIED,
      decidedBy: req.user.uid,
      decidedOn: Date.now(),
      decisionNote: req.body.decisionNote || '',
    });

    await notify(
      request.uid,
      `Access request declined: ${resource ? resource.name : request.groupCn}`,
      `<p>Your request for <strong>${resource ? resource.name : request.groupCn}</strong> was declined.</p>` +
      (req.body.decisionNote ? `<p>Reason: ${req.body.decisionNote}</p>` : '')
    );

    res.json(envelope(updated));
  } catch (err) { next(err); }
});

// DELETE /api/access-requests/:id — requester withdraws their own pending request.
router.delete('/:id', async (req, res, next) => {
  try {
    const request = await AccessRequest.get(req.params.id);
    if (!request) throw httpError(404, 'Request not found');
    if (request.uid !== req.user.uid) {
      throw httpError(403, 'You can only withdraw your own requests.');
    }
    if (request.status !== STATUS.PENDING) {
      throw httpError(409, `This request was already ${request.status}.`);
    }
    const updated = await request.update({ status: STATUS.CANCELLED, decidedOn: Date.now() });
    res.json(envelope(updated));
  } catch (err) { next(err); }
});

module.exports = router;
