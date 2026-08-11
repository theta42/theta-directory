'use strict';

// A minimal in-process async mutex.
//
// Exists for read-then-write allocations that must not interleave — the
// motivating case being LDAP ServerID assignment in routes/api_site.js: two
// spokes registering at the same moment both ran "list the used ids, pick the
// lowest free one, create the row", both read the same set, and both were
// assigned the same id. Duplicate ServerIDs do not fail loudly; they break
// OpenLDAP multi-master replication quietly, because ServerID is how syncrepl
// tells originators apart.
//
// This lock is a serialization convenience, NOT the guarantee. Uniqueness is
// enforced by a database unique index (models/index.js: ensureUniqueIndexes),
// because this Map is process-local: run the app as two processes against one
// database and the lock silently protects nothing. Keep both.
//
// Two ways a caller can hang forever on a naive mutex, and what is done here:
//
//   1. Re-entry. `fn` takes the same lock again, directly or through a helper.
//      Detected via AsyncLocalStorage — the second acquisition throws with the
//      lock name instead of waiting on a promise that can never settle.
//
//   2. Re-entry from another node. POST /api/site/master-changed makes a spoke
//      turn around and call THIS node's POST /api/site/spokes, which takes the
//      same lock; hold it across the outbound call and the two sides wait on
//      each other. AsyncLocalStorage cannot see across the network, so the
//      backstop is an acquisition timeout that names the current holder rather
//      than an express handler that never responds. (This really happened
//      during promotion; the symptom on the caller was a misleading
//      "re-point failed: This operation was aborted" — its own fetch timeout —
//      while the callee sat deadlocked. See utils/site_promote.js.)

const { AsyncLocalStorage } = require('node:async_hooks');

// Locks currently held or contended, keyed by name. Entries are deleted on
// release when nothing is waiting, so a caller that derives lock names from
// data (`'spoke-' + id`) does not leak an entry per key.
const locks = new Map();

// The set of lock names held by the current async context. Propagates through
// awaits, so it is still accurate several calls deep inside the critical
// section — which is exactly where an accidental re-entry gets written.
const heldNames = new AsyncLocalStorage();

const ACQUIRE_TIMEOUT_MS = 30000;

function state(name) {
	let s = locks.get(name);
	if (!s) {
		s = { held: false, holder: null, since: 0, waiters: [] };
		locks.set(name, s);
	}
	return s;
}

function acquire(s, name, timeoutMs) {
	if (!s.held) {
		s.held = true;
		return Promise.resolve();
	}
	return new Promise((resolve, reject) => {
		const waiter = { resolve, timer: null };
		if (timeoutMs > 0) {
			waiter.timer = setTimeout(() => {
				const i = s.waiters.indexOf(waiter);
				// Drop out of the queue: a waiter that gave up must never have
				// its `fn` run later.
				if (i !== -1) s.waiters.splice(i, 1);
				if (!s.held && s.waiters.length === 0) locks.delete(name);
				reject(new Error(
					`timed out after ${timeoutMs}ms waiting for lock "${name}" ` +
					`(held by ${s.holder || 'unknown'} for ${Date.now() - s.since}ms)`
				));
			}, timeoutMs);
			// Never keep the process alive just to fail a waiter.
			if (waiter.timer.unref) waiter.timer.unref();
		}
		s.waiters.push(waiter);
	});
}

function release(s, name) {
	const next = s.waiters.shift();
	if (!next) {
		s.held = false;
		s.holder = null;
		s.since = 0;
		locks.delete(name);
		return;
	}
	// Hand the lock straight over — `held` stays true, so a caller arriving
	// between this release and the waiter resuming queues behind it rather
	// than jumping the line. Clear the holder so a timeout firing in that
	// window cannot name a section that has already finished.
	s.holder = null;
	s.since = Date.now();
	if (next.timer) clearTimeout(next.timer);
	next.resolve();
}

// Runs `fn` with exclusive access to `name`, FIFO.
//
// `fn` is called with NO arguments: `previous.then(fn)` would hand it the
// prior holder's resolution value, which is a trap waiting for whoever next
// changes what the chain resolves to.
//
// Options: `timeoutMs` (0 disables the acquisition timeout — only for callers
// that genuinely may queue for minutes) and `label`, which is reported to
// whoever times out waiting, so the message says who is holding the lock.
async function withLock(name, fn, options = {}) {
	const { timeoutMs = ACQUIRE_TIMEOUT_MS, label = '' } = options;

	const outer = heldNames.getStore();
	if (outer && outer.has(name)) {
		throw new Error(
			`withLock("${name}") re-entered while this context already holds it — ` +
			'this would deadlock; move the nested work outside the critical section'
		);
	}

	const s = state(name);
	await acquire(s, name, timeoutMs);

	s.holder = label || 'unlabelled';
	s.since = Date.now();

	const inner = new Set(outer || []);
	inner.add(name);

	try {
		return await heldNames.run(inner, fn);
	} finally {
		release(s, name);
	}
}

// Introspection for tests and health output. Never used for control flow:
// "is it held" is stale the moment it returns.
function lockState(name) {
	const s = locks.get(name);
	if (!s) return null;
	return { held: s.held, holder: s.holder, waiters: s.waiters.length, heldForMs: s.since ? Date.now() - s.since : 0 };
}

module.exports = { withLock, lockState, ACQUIRE_TIMEOUT_MS, _locks: locks };
