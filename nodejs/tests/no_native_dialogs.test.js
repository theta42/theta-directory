'use strict';

// Regression guard: native alert()/confirm()/prompt() calls block all further
// browser events on the page (found live, mid browser-automation testing, on
// directory.ejs's "Rotate Client Secret" — it froze the tab entirely) and are
// visually inconsistent with the rest of the UI. Every call site was removed
// in favor of app.messages.action/confirm/toast and app.modal.open; this test
// keeps it that way.

const fs = require('fs');
const path = require('path');

const ROOTS = ['views', 'public/js', 'public/lib/js'].map((d) => path.join(__dirname, '..', d));

// Matches a bare alert(/confirm(/prompt( call, but not app.messages.*,
// app.modal.*, or identifiers merely containing these words (e.g.
// "confirmation", ".confirmed").
const NATIVE_DIALOG_RE = /(^|[^.\w$])(alert|confirm|prompt)\s*\(/g;

function walk(dir) {
	let files = [];
	if (!fs.existsSync(dir)) return files;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files = files.concat(walk(full));
		else if (/\.(ejs|js)$/.test(entry.name)) files.push(full);
	}
	return files;
}

test('no view or client-side script calls native alert()/confirm()/prompt()', () => {
	const offenders = [];
	for (const root of ROOTS) {
		for (const file of walk(root)) {
			const src = fs.readFileSync(file, 'utf8');
			let m;
			NATIVE_DIALOG_RE.lastIndex = 0;
			while ((m = NATIVE_DIALOG_RE.exec(src))) {
				const line = src.slice(0, m.index).split('\n').length;
				offenders.push(`${path.relative(path.join(__dirname, '..'), file)}:${line} — ${m[2]}(`);
			}
		}
	}
	expect(offenders).toEqual([]);
});
