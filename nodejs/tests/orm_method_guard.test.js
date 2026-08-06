'use strict';

const fs = require('fs');
const path = require('path');

// @simpleworkjs/orm models expose `list`/`get`/`count`/`create` -- there is no
// `find`, `findOne`, `findAll` or `where`. Calling one is not a syntax error and
// nothing catches it until the line actually runs, so it can sit in a rarely
// exercised path indefinitely.
//
// It did: `models/sms.js` called `PluginInstance.find({...})`, which threw
// "is not a function" on EVERY SMS send -- the test button, OTP-by-SMS and
// notifications alike -- before it could even reach the VoIP.ms fallback. SMS
// delivery had simply never worked.
const ORM_MODELS = [
	'Resource', 'ResourceEdge', 'ResourceGroup', 'AccessRequest', 'Webhook',
	'PluginInstance', 'SharedSecret', 'SharedSecretGrant', 'VaultAppToken',
	'Agent', 'AgentJoinKey',
];
const MISSING_STATICS = ['find', 'findOne', 'findAll', 'findAndCountAll', 'where'];

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['models', 'routes', 'services', 'utils', 'plugins', 'controller', 'middleware'];

function walk(dir, out = []) {
	let entries;
	try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') continue;
			walk(full, out);
		} else if (entry.name.endsWith('.js')) {
			out.push(full);
		}
	}
	return out;
}

// Strip comments so a line *describing* the bug (like the one in models/sms.js)
// isn't reported as the bug.
function stripComments(src) {
	return src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('no source file calls an ORM static that does not exist', () => {
	const pattern = new RegExp(
		`\\b(${ORM_MODELS.join('|')})\\s*\\.\\s*(${MISSING_STATICS.join('|')})\\s*\\(`,
		'g'
	);

	const offenders = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(path.join(ROOT, dir))) {
			const src = stripComments(fs.readFileSync(file, 'utf8'));
			src.split('\n').forEach((line, i) => {
				const m = line.match(pattern);
				if (m) offenders.push(`${path.relative(ROOT, file)}:${i + 1} — ${m.join(', ')}`);
			});
		}
	}

	expect(offenders).toEqual([]);
});

// models/email.js exports `{Mail}`, not a bare sender. Requiring the module and
// calling `.send` on it -- as routes/api_conf.js's test-email did -- always
// threw "Email.send is not a function", so the Test Email button could never
// have worked.
test('the email module exports Mail.send and callers destructure it', () => {
	const mod = require('../models/email');
	expect(typeof mod.Mail).toBe('object');
	expect(typeof mod.Mail.send).toBe('function');
	// The bare module has no send() -- this is exactly the mistake to catch.
	expect(mod.send).toBeUndefined();

	const offenders = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(path.join(ROOT, dir))) {
			const src = stripComments(fs.readFileSync(file, 'utf8'));
			// `X = require('...email')` followed by `X.send(` where X was not
			// destructured.
			const assigned = [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\([^)]*models\/email[^)]*\)/g)]
				.map(m => m[1]);
			for (const name of assigned) {
				if (new RegExp(`\\b${name}\\s*\\.\\s*send\\s*\\(`).test(src)) {
					offenders.push(`${path.relative(ROOT, file)} — ${name}.send(), but the module exports {Mail}`);
				}
			}
		}
	}
	expect(offenders).toEqual([]);
});

// The VoIP.ms REST API is a GET against voip.ms/api/v1/rest.php with
// api_username/api_password and method=sendSMS. `api.voip.ms/v1.0/sms/send`
// (which test-sms used to POST to with Basic auth) does not exist -- it
// returned an HTML page, so response.json() threw
// `Unexpected token '<', "<!DOCTYPE "...` and the button reported that.
test('nothing targets the non-existent api.voip.ms host', () => {
	const offenders = [];
	for (const dir of SCAN_DIRS) {
		for (const file of walk(path.join(ROOT, dir))) {
			// Comments stripped: the note in routes/api_conf.js explaining this
			// very bug names the bad host, and describing a mistake is not
			// making it.
			const src = stripComments(fs.readFileSync(file, 'utf8'));
			src.split('\n').forEach((line, i) => {
				if (line.includes('api.voip.ms')) {
					offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
				}
			});
		}
	}
	expect(offenders).toEqual([]);
});
