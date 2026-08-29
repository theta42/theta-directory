'use strict';

const crypto = require('crypto');

// Push-token forwarding authentication (H-14).
//
// A bearer push token on its own is a static credential: anyone who captures
// it can replay the request later. So every forwarded write is signed with an
// HMAC over (uid, timestamp, path) keyed by the push token. The verifier
// recomputes the HMAC and checks the timestamp is within ±5 minutes, which
// binds the request to a specific caller, path, and window and defeats replay
// of anything intercepted.
//
//   x-forwarded-mac = hex(hmac_sha256(pushToken, uid + "\n" + ts + "\n" + path))
//
// `path` is the absolute request path (e.g. '/api/user'), independent of where
// the receiving router is mounted.

const WINDOW_MS = 5 * 60 * 1000; // ±5 minutes

function sign(pushToken, uid, ts, path) {
	const msg = `${uid}\n${ts}\n${path}`;
	return crypto.createHmac('sha256', String(pushToken || '')).update(msg, 'utf8').digest('hex');
}

function verify(pushToken, uid, ts, path, mac) {
	if (!pushToken || !uid || !ts || !mac) return false;
	const now = Date.now();
	const t = Number(ts);
	if (!Number.isFinite(t)) return false;
	if (Math.abs(now - t) > WINDOW_MS) return false;
	const expected = sign(pushToken, uid, ts, path);
	const a = Buffer.from(expected, 'hex');
	const b = Buffer.from(String(mac), 'hex');
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

module.exports = { sign, verify, WINDOW_MS };
