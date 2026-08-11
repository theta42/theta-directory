'use strict';

// utils/mutex.js — the serialization behind LDAP ServerID allocation.
//
// The behaviours worth pinning down are the failure modes, not the happy path:
// a mutex that deadlocks silently is worse than no mutex, because the symptom
// surfaces somewhere else entirely (during promotion it showed up on the
// CALLING node as "re-point failed: This operation was aborted", which is that
// node's own fetch timeout, while the callee sat waiting on itself).

const { withLock, lockState, _locks } = require('../utils/mutex');

afterEach(() => { _locks.clear(); });

describe('mutual exclusion', () => {
	test('critical sections do not interleave', async () => {
		const events = [];
		const section = (tag) => withLock('m', async () => {
			events.push(tag + ':enter');
			await new Promise((r) => setTimeout(r, 10));
			events.push(tag + ':exit');
		});

		await Promise.all([section('a'), section('b'), section('c')]);

		expect(events).toEqual([
			'a:enter', 'a:exit', 'b:enter', 'b:exit', 'c:enter', 'c:exit'
		]);
	});

	test('waiters are served FIFO', async () => {
		const order = [];
		const jobs = ['1', '2', '3', '4'].map((n) =>
			withLock('fifo', async () => { order.push(n); await new Promise((r) => setTimeout(r, 5)); }));
		await Promise.all(jobs);
		expect(order).toEqual(['1', '2', '3', '4']);
	});

	test('different names do not block each other', async () => {
		let bRan = false;
		await withLock('a', async () => {
			await withLock('b', async () => { bRan = true; });
		});
		expect(bRan).toBe(true);
	});

	test('a rejection releases the lock and the caller still sees the error', async () => {
		await expect(withLock('r', async () => { throw new Error('boom'); })).rejects.toThrow('boom');

		// The next waiter must not inherit the failure.
		await expect(withLock('r', async () => 'fine')).resolves.toBe('fine');
	});

	test('a rejection mid-queue does not break the waiters behind it', async () => {
		const results = [];
		let caught = null;
		const jobs = [
			withLock('q', async () => { results.push('ok1'); }),
			// The .catch runs a microtask after the section rejects, by which
			// point the next holder has already been let in — so record the
			// failure separately and assert on the sections' own order.
			withLock('q', async () => { results.push('boom'); throw new Error('middle'); })
				.catch((e) => { caught = e.message; }),
			withLock('q', async () => { results.push('ok2'); })
		];
		await Promise.all(jobs);
		expect(results).toEqual(['ok1', 'boom', 'ok2']);
		expect(caught).toBe('middle');
	});

	test('the return value is passed through', async () => {
		await expect(withLock('v', async () => 42)).resolves.toBe(42);
	});
});

// `previous.then(fn, fn)` handed `fn` the previous holder's resolution value
// and used `fn` as its own rejection handler. Both were invisible only because
// the chain happened to resolve to undefined and never reject.
describe('the callback contract', () => {
	test('fn is called with no arguments', async () => {
		let args = null;
		await withLock('args', async (...a) => { args = a; });
		expect(args).toEqual([]);

		// ...including when it follows a section that returned a value.
		let second = null;
		await withLock('args', async () => 'leaked-value');
		await withLock('args', async (...a) => { second = a; });
		expect(second).toEqual([]);
	});

	test('fn is not re-run when a previous holder rejects', async () => {
		let calls = 0;
		await withLock('once', async () => { calls++; throw new Error('x'); }).catch(() => {});
		expect(calls).toBe(1);
	});
});

// The deadlock that actually happened, reduced: work inside the critical
// section reaches back for the same lock.
describe('re-entrancy', () => {
	test('re-entering the same lock throws instead of hanging', async () => {
		await expect(withLock('re', async () => {
			await withLock('re', async () => 'never');
		})).rejects.toThrow(/re-entered while this context already holds it/);
	});

	test('detection survives several awaits into the critical section', async () => {
		const deepHelper = async () => {
			await new Promise((r) => setTimeout(r, 5));
			return withLock('deep', async () => 'never');
		};
		await expect(withLock('deep', async () => {
			await new Promise((r) => setTimeout(r, 5));
			return deepHelper();
		})).rejects.toThrow(/re-entered/);
	});

	test('a rejected re-entry still releases the outer lock', async () => {
		await withLock('rel', async () => {
			await withLock('rel', async () => {}).catch(() => {});
		});
		await expect(withLock('rel', async () => 'free')).resolves.toBe('free');
	});

	test('taking the lock AFTER the section returns is not re-entry', async () => {
		// This is the shape utils/site_promote.js relies on: phase 1 under the
		// lock, phase 2 outside it.
		await withLock('seq', async () => 'phase1');
		await expect(withLock('seq', async () => 'phase2')).resolves.toBe('phase2');
	});
});

// AsyncLocalStorage cannot see a re-entry that arrives back over HTTP from
// another node, so the timeout is the backstop for that case.
describe('acquisition timeout', () => {
	test('a waiter that times out reports the lock name and holder', async () => {
		let release;
		const holder = withLock('t', () => new Promise((r) => { release = r; }), { label: 'slow-holder' });

		await expect(withLock('t', async () => 'never', { timeoutMs: 30 }))
			.rejects.toThrow(/waiting for lock "t" \(held by slow-holder/);

		release();
		await holder;
	});

	test('a timed-out waiter never runs its callback, even later', async () => {
		let release;
		let ran = false;
		const holder = withLock('t2', () => new Promise((r) => { release = r; }));

		await expect(withLock('t2', async () => { ran = true; }, { timeoutMs: 20 })).rejects.toThrow(/timed out/);

		release();
		await holder;
		await new Promise((r) => setTimeout(r, 30));
		expect(ran).toBe(false);
	});

	test('a timed-out waiter does not block the ones behind it', async () => {
		let release;
		const holder = withLock('t3', () => new Promise((r) => { release = r; }));

		const impatient = withLock('t3', async () => 'no', { timeoutMs: 20 }).catch((e) => e.message);
		const patient = withLock('t3', async () => 'yes');

		await expect(impatient).resolves.toMatch(/timed out/);
		release();
		await holder;
		await expect(patient).resolves.toBe('yes');
	});

	test('timeoutMs 0 waits indefinitely', async () => {
		let release;
		const holder = withLock('t4', () => new Promise((r) => { release = r; }));
		const waiter = withLock('t4', async () => 'eventually', { timeoutMs: 0 });

		await new Promise((r) => setTimeout(r, 30));
		release();
		await holder;
		await expect(waiter).resolves.toBe('eventually');
	});
});

// A name derived from data ('spoke-' + id) must not leak a Map entry per key.
describe('bookkeeping', () => {
	test('the entry is dropped once the lock is idle', async () => {
		await withLock('gc', async () => {});
		expect(lockState('gc')).toBeNull();
		expect(_locks.size).toBe(0);
	});

	test('the entry is dropped after a rejection too', async () => {
		await withLock('gc2', async () => { throw new Error('x'); }).catch(() => {});
		expect(_locks.size).toBe(0);
	});

	test('the entry survives while waiters are queued, then is dropped', async () => {
		let release;
		const holder = withLock('gc3', () => new Promise((r) => { release = r; }), { label: 'held' });
		const waiter = withLock('gc3', async () => {});

		await new Promise((r) => setTimeout(r, 5));
		expect(lockState('gc3')).toMatchObject({ held: true, holder: 'held', waiters: 1 });

		release();
		await holder;
		await waiter;
		expect(_locks.size).toBe(0);
	});

	test('every timed-out waiter is cleaned up', async () => {
		let release;
		const holder = withLock('gc4', () => new Promise((r) => { release = r; }));
		const losers = [1, 2, 3].map(() => withLock('gc4', async () => {}, { timeoutMs: 15 }).catch(() => 'gone'));

		await Promise.all(losers);
		expect(lockState('gc4').waiters).toBe(0);

		release();
		await holder;
		expect(_locks.size).toBe(0);
	});
});
