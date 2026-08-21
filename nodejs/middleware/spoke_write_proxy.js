'use strict';

/**
 * Spoke Write Proxy Middleware — the "Pragmatic Hub & Spoke" write path.
 *
 * On a spoke, reads always serve locally from the edge cache. A mutating
 * request is forwarded to the master ONLY when the state it writes actually
 * replicates back to this node.
 *
 * ── Why an ALLOWLIST, not a deny-list ───────────────────────────────────────
 *
 * The first version of this forwarded every POST/PUT/PATCH/DELETE under /api
 * and exempted a handful of paths. Both halves of that were wrong:
 *
 *  1. The exemptions never fired. This middleware is mounted with
 *     `app.use('/api', ...)`, and Express strips the mount prefix, so `req.path`
 *     here is `/site/resync` — while every EXEMPT_PATHS entry was written
 *     against `/api/site/...`. Nothing ever matched. That silently forwarded
 *     the master's own replication ping (`POST /api/site/resync`) straight back
 *     to the master, which answers "this node is master" — so live replication
 *     to every spoke was dead. It also forwarded the local gateway's
 *     `PUT /api/mesh/self`, which made each spoke's WireGuard key overwrite the
 *     MASTER's roster row, and `POST /api/v1/ldap/bind`, which is the SSSD
 *     auth path and must never leave the site. Matching is done on the ABSOLUTE
 *     path below so it cannot depend on where this is mounted.
 *
 *  2. Forwarding by default is wrong even when the matching works. Forwarding
 *     state that does NOT replicate back makes it invisible at the site that
 *     wrote it: a user secret written to /api/vault would land in the master's
 *     OpenBao while the spoke keeps reading its own, an OAuth client would be
 *     created where this site's proxy can't see it. So the rule is: forward a
 *     write if and only if the master is genuinely authoritative for it AND it
 *     comes back — LDAP identity (MMR), the Resource catalog, agent fleet rows,
 *     and user verification, all of which ride POST /api/site/export. Anything
 *     else stays local, exactly as it behaved before hub-and-spoke existed.
 *
 * ── Credential ──────────────────────────────────────────────────────────────
 *
 * A forwarded request authenticates with this spoke's `replicationPushToken`
 * plus `X-Forwarded-User`, never with the site join key. The join key is a
 * cluster-wide credential that is pasted into every spoke's `spoke.env` and
 * handed out to operators; letting it assert "I am uid X" made it a
 * cluster-wide impersonation credential for any user, `god_admin` included
 * (see middleware/auth.js). The push token is per-spoke, minted by the master,
 * and never leaves this node's /config/site.json.
 *
 * The caller's own credential is resolved locally first (session token, PAT,
 * or machine ServiceToken) so the master learns WHO acted. A request whose
 * caller cannot be resolved is passed to the local router, which produces its
 * normal 401 — this middleware never invents an identity.
 *
 * If the master is unreachable, a forwarded write returns 503: the directory
 * is in read-only offline mode. Local reads, SSSD auth and DNS keep working.
 */

const siteConfig = require('../utils/site_config');
const { fetchWithAuthRedirect } = require('../utils/fetch_with_auth_redirect');

// Writes the master owns AND replicates back to this node.
//
//   /user, /group, /ldif-import  → LDAP identity; comes back over MMR syncrepl
//   /tos                         → UserVerification; in POST /api/site/export
//   /directory-admin             → the Resource catalog; in the export
//   /agent/enroll, /agent/nodes  → Agent fleet rows; in the export
//   /api-token                   → ApiToken (PAT) rows; in the export
//
// Two neighbours that look like they belong here and do NOT, both for the same
// reason -- the record itself is not replicated, so forwarding it would file it
// somewhere the site that created it can never see:
//
//   /access-requests    the AccessRequest row is local. Forwarding it means a
//                       user raises a request at their own site and neither
//                       they nor the local approver can ever see it. Approval
//                       does an LDAP group add, and the local slapd is a real
//                       multi-provider MMR peer, so the grant still reaches the
//                       whole cluster.
//   /agent/join-keys    AgentJoinKey is local. A key minted here has to be
//                       redeemable here -- that is the entire enrolment flow.
const FORWARD_PATHS = [
  /^\/api\/user(\/|$)/,
  /^\/api\/group(\/|$)/,
  /^\/api\/ldif-import(\/|$)/,
  /^\/api\/tos(\/|$)/,
  /^\/api\/directory-admin(\/|$)/,
  /^\/api\/agent\/enroll(\/|$)/,
  /^\/api\/agent\/nodes(\/|$)/,
  /^\/api\/api-token(\/|$)/
];

// Carve-outs inside the paths above, for the two operations that are about
// THIS node rather than about cluster state:
//
//   site-promote  — the one mutating request a spoke must be able to make to
//                   itself; forwarding it makes the master re-promote itself
//                   and the spoke silently stays a spoke.
//   node command  — an agent command needs the live WebSocket, which is held
//                   by whichever node the agent actually connected to, so it
//                   runs on the node the operator addressed.
const NEVER_FORWARD = [
  /^\/api\/directory-admin\/site-promote(\/|$)/,
  /^\/api\/agent\/nodes\/[^/]+\/command(\/|$)/
];

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];
const FORWARD_TIMEOUT_MS = 30000;

// The absolute request path, independent of where this middleware is mounted.
// req.path is mount-relative ('/site/join'); originalUrl is not ('/api/site/join').
function absolutePath(req) {
  const url = req.originalUrl || req.url || '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

function shouldForward(path) {
  if (NEVER_FORWARD.some((re) => re.test(path))) return false;
  return FORWARD_PATHS.some((re) => re.test(path));
}

// Resolve the caller against this node's own credentials, so the master is
// told who acted. Covers every credential the local routers themselves accept.
async function resolveCaller(req) {
  if (req.user) return req.user;

  const { Auth } = require('../models/auth');
  const authz = String(req.headers['authorization'] || '');
  if (authz.slice(0, 7).toLowerCase() === 'bearer ') {
    const token = authz.slice(7).trim();
    if (token.startsWith('sso_')) {
      const user = await Auth.checkApiToken(token).catch(() => null);
      if (user && user.uid) return user;
    } else {
      const { ServiceToken } = require('../models/token');
      const svc = await ServiceToken.get(token).catch(() => null);
      if (svc && svc.is_valid) {
        return { uid: svc.resource_id, isMachine: true, name: 'Machine Account' };
      }
    }
  }

  const sessionToken = req.headers['auth-token'];
  if (sessionToken) {
    const user = await Auth.checkToken({ token: sessionToken }).catch(() => null);
    if (user && user.uid) return user;
  }

  return null;
}

// Response headers that describe the transfer we just terminated, not the
// payload we are about to re-send. content-length is included because the body
// is re-framed here (undici has already decompressed it).
const HOP_BY_HOP = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'
]);

function copyResponseHeaders(resp, res) {
  // set-cookie must go through getSetCookie(): iterating headers folds multiple
  // cookies into one comma-joined value, which silently corrupts all but the
  // first.
  const setCookies = typeof resp.headers.getSetCookie === 'function' ? resp.headers.getSetCookie() : null;
  for (const [k, v] of resp.headers.entries()) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === 'set-cookie' && setCookies) continue;
    res.setHeader(k, v);
  }
  if (setCookies && setCookies.length) res.setHeader('set-cookie', setCookies);
}

// After a successful forwarded write, a couple of pieces of local state are
// derived from data that now lives on the master. Refresh them immediately
// rather than making the user wait for the next resync push — the onboarding
// flow reads them back on the very next request.
async function refreshLocalDerivedState(req, user) {
  try {
    const userMod = require('../models/user');
    const UserModel = userMod.User || userMod;
    if (UserModel && typeof UserModel.clearCache === 'function') UserModel.clearCache();
  } catch (e) { /* cache is an optimisation; never fail a write over it */ }

  if (!user || !user.uid) return;
  const path = absolutePath(req);
  try {
    const { UserVerification } = require('../models/verification');
    if (/^\/api\/user\/accept-tos(\/|$)/.test(path)) {
      const verif = await UserVerification.getOrCreate(user.uid);
      await verif.markTosAccepted();
    } else if (/^\/api\/user\/password(\/|$)/.test(path)) {
      const verif = await UserVerification.getOrCreate(user.uid);
      await verif.update({ password_must_change: false });
    }
  } catch (e) { /* the next resync carries it */ }

  // Onboarding date-of-birth edits are forwarded to the master, but the
  // onboarding page reloads /api/user/me immediately and would otherwise still
  // see the old value until LDAP syncrepl catches up. Apply the same edit
  // locally, best-effort, so the next read is correct and the user can proceed.
  try {
    if (/^\/api\/user\/[^/]+(\/|$)/.test(path)
        && ['PUT', 'PATCH'].includes(req.method)
        && (req.body || {}).dateOfBirth) {
      const userMod = require('../models/user');
      const UserModel = userMod.User || userMod;
      const localUser = await UserModel.get(user.uid);
      if (localUser && typeof localUser.update === 'function') {
        await localUser.update({ dateOfBirth: req.body.dateOfBirth });
      }
    }
  } catch (e) { /* non-fatal: syncrepl will converge it */ }
}

async function spokeWriteProxy(req, res, next) {
  const cfg = siteConfig.get();

  // The master is the write authority; nothing to proxy.
  if (cfg.isMaster) return next();

  if (!MUTATING.includes(req.method)) return next();

  const path = absolutePath(req);
  if (!shouldForward(path)) return next();

  const masterUrl = String(cfg.masterUrl || '').replace(/\/+$/, '');
  if (!masterUrl) {
    return res.status(503).json({
      status: 'error',
      message: 'This node is a spoke with no master URL configured. The directory is in read-only offline mode.'
    });
  }

  // Per-spoke credential only — see the header note on why the join key is not
  // accepted for this.
  const pushToken = cfg.replicationPushToken;
  if (!pushToken) {
    return res.status(503).json({
      status: 'error',
      message: 'This spoke is not registered with its master for live replication, so directory writes cannot be '
        + 'attributed to it. Re-register it (Directory → Multi-Site → Re-register, or POST /api/site/reregister) '
        + 'and try again.'
    });
  }

  const user = await resolveCaller(req);
  // Let the local router's own auth produce the canonical 401 rather than
  // guessing an identity here.
  if (!user || !user.uid) return next();

  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase();
    if (['host', 'content-length', 'transfer-encoding', 'connection', 'authorization', 'auth-token', 'cookie'].includes(key)) continue;
    forwardHeaders[key] = v;
  }
  forwardHeaders['authorization'] = 'Bearer ' + pushToken;
  forwardHeaders['x-forwarded-user'] = user.uid;
  forwardHeaders['x-forwarded-spoke'] = cfg.siteSlug || 'spoke';
  forwardHeaders['x-forwarded-for'] = req.ip || req.headers['x-forwarded-for'] || '';
  forwardHeaders['x-forwarded-proto'] = req.protocol || 'http';

  let body;
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    body = JSON.stringify(req.body);
    forwardHeaders['content-type'] = 'application/json';
  } else if (typeof req.body === 'string' && req.body.length > 0) {
    body = req.body;
  }

  let resp;
  try {
    resp = await fetchWithAuthRedirect(masterUrl + (req.originalUrl || req.url), {
      method: req.method,
      headers: forwardHeaders,
      body
    }, { timeoutMs: FORWARD_TIMEOUT_MS });
  } catch (err) {
    return res.status(503).json({
      status: 'error',
      message: `Master directory at ${masterUrl} is unreachable for write operations (${err.message}). `
        + 'This site is in read-only offline mode; reads, SSSD auth and DNS are unaffected.'
    });
  }

  const data = Buffer.from(await resp.arrayBuffer());
  if (resp.ok) await refreshLocalDerivedState(req, user);

  res.status(resp.status);
  res.setHeader('x-theta-forwarded-spoke', cfg.siteSlug || 'spoke');
  copyResponseHeaders(resp, res);
  return res.send(data);
}

module.exports = spokeWriteProxy;
module.exports.FORWARD_PATHS = FORWARD_PATHS;
module.exports.NEVER_FORWARD = NEVER_FORWARD;
module.exports.shouldForward = shouldForward;
