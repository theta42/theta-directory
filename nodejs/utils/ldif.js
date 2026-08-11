'use strict';

// A standalone RFC 2849 LDIF parser.
//
// Deliberately schema-agnostic: it knows how LDIF is *encoded*, not what any
// attribute means. Everything that decides "this entry is a user" lives in
// utils/ldif_import.js, so pointing the importer at a directory this codebase
// has never seen is a mapping change rather than a parser change.
//
// Scope is content records (the output of `slapcat` / `ldapsearch -LLL`), which
// is what an operator migrating a directory actually has. Change records
// (`changetype: modify` and friends) are recognized only so they can be
// rejected with a clear message instead of being silently misread as content.

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

// LDIF folds long lines by starting the continuation with a single space. That
// space is part of the syntax, not the value, and the value may itself begin
// with a space -- which is why such values are base64-encoded at the source.
function unfold(text) {
	const lines = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const out = [];
	for (const line of lines) {
		if (line.startsWith(' ') && out.length) {
			out[out.length - 1] += line.slice(1);
		} else {
			out.push(line);
		}
	}
	return out;
}

// `attr: value`, `attr:: base64value`, or `attr:< url`.
function parseLine(line) {
	const colon = line.indexOf(':');
	if (colon === -1) return null;

	const name = line.slice(0, colon);
	let rest = line.slice(colon + 1);
	let encoding = 'plain';

	if (rest.startsWith(':')) {
		encoding = 'base64';
		rest = rest.slice(1);
	} else if (rest.startsWith('<')) {
		encoding = 'url';
		rest = rest.slice(1);
	}

	// Exactly one optional space after the marker is syntax; any further
	// leading whitespace belongs to the value.
	if (rest.startsWith(' ')) rest = rest.slice(1);

	if (encoding === 'base64') {
		// Buffer.from is famously permissive -- it silently drops anything
		// outside the alphabet rather than throwing -- so a corrupted dump would
		// otherwise import as a plausible-looking wrong value.
		const cleaned = rest.replace(/\s+/g, '');
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
			throw Object.assign(new Error(`invalid base64 in attribute "${name}"`), { status: 400 });
		}
		return { name, value: Buffer.from(cleaned, 'base64').toString('utf8') };
	}

	if (encoding === 'url') {
		// `attr:< file:///etc/shadow` would make the parser read arbitrary files
		// on behalf of whoever uploaded the dump. Never resolved.
		throw Object.assign(
			new Error(`attribute "${name}" uses a URL reference (:<), which is not supported for security reasons`),
			{ status: 400 }
		);
	}

	return { name, value: rest };
}

// Returns [{ dn, attrs }] where attrs maps a lowercased attribute name to an
// array of string values. Order within an attribute is preserved.
function parseLDIF(text) {
	if (text === null || text === undefined) return [];

	const lines = unfold(text);
	const entries = [];
	let current = null;
	let lineNo = 0;

	const finish = () => {
		if (current) entries.push(current);
		current = null;
	};

	for (const raw of lines) {
		lineNo++;

		if (raw === '') { finish(); continue; }
		if (raw.startsWith('#')) continue;
		// The record separator in some dumps, and the modify-op separator in
		// change records. Harmless to skip in content.
		if (raw === '-') continue;
		if (/^version:\s*\d+\s*$/i.test(raw)) continue;

		let parsed;
		try {
			parsed = parseLine(raw);
		} catch (error) {
			error.message = `line ${lineNo}: ${error.message}`;
			throw error;
		}
		if (!parsed) continue;

		const name = parsed.name.toLowerCase();

		if (name === 'dn') {
			finish();
			current = { dn: parsed.value, attrs: {} };
			continue;
		}

		if (!current) continue; // attribute before any dn: ignore rather than guess

		if (name === 'changetype') {
			throw Object.assign(
				new Error(
					`line ${lineNo}: this is an LDIF change record (changetype: ${parsed.value}), ` +
					'not a directory dump. Export with `slapcat` or `ldapsearch -LLL` instead.'
				),
				{ status: 400 }
			);
		}

		// Attribute options (`userCertificate;binary`) qualify the encoding of a
		// value, not its identity. Keep the base name so callers can find it.
		const base = name.split(';')[0];
		if (!current.attrs[base]) current.attrs[base] = [];
		current.attrs[base].push(parsed.value);
	}
	finish();

	for (const entry of entries) {
		if (CONTROL_CHARS.test(entry.dn)) {
			throw Object.assign(new Error(`DN contains control characters: ${JSON.stringify(entry.dn)}`), { status: 400 });
		}
	}

	return entries;
}

// First value of an attribute, or '' -- most callers want a scalar and LDIF is
// multi-valued everywhere.
function one(entry, name) {
	const values = entry.attrs[String(name).toLowerCase()];
	return (values && values.length) ? values[0] : '';
}

// All values of an attribute, always an array.
function all(entry, name) {
	return entry.attrs[String(name).toLowerCase()] || [];
}

// Lowercased objectClass set, for membership tests.
function objectClasses(entry) {
	return new Set(all(entry, 'objectClass').map((v) => v.toLowerCase()));
}

// The parent DN, i.e. everything after the first unescaped comma. LDAP allows a
// comma inside an RDN value when escaped (`cn=Doe\, John`), so a plain split
// would cut in the wrong place.
function parentDN(dn) {
	let escaped = false;
	for (let i = 0; i < dn.length; i++) {
		const ch = dn[i];
		if (escaped) { escaped = false; continue; }
		if (ch === '\\') { escaped = true; continue; }
		if (ch === ',') return dn.slice(i + 1).trim();
	}
	return '';
}

module.exports = { parseLDIF, one, all, objectClasses, parentDN };
