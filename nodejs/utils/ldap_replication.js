'use strict';

// OpenLDAP multi-master replication (docs/replication.md) config derivation,
// shared between routes/api_site.js (the spoke-facing side: assigns a
// ServerID at registration, serves GET /api/site/ldap-peers) and
// routes/api_directory_admin.js (the master-local side: GET
// /directory-admin/ldap-replication-config computes the master's own
// replication config from the same SiteSpoke registry, no HTTP round-trip
// needed since it already has the data).

const { SiteSpoke } = require('../models/site_spoke');

// The master reserves ServerID 1 for itself; every spoke gets the lowest
// free ID from 2 upward, assigned once at registration and reused across
// re-registrations (SiteSpoke.ldapServerId is only ever set on first
// create). Small max, matching mesh_gateway.js's mesh index -- nothing in
// the OpenLDAP protocol requires a small ServerID, but this deployment's
// docs/examples always have.
const MAX_LDAP_SERVER_ID = 4094;

async function nextFreeLdapServerId() {
	const spokes = await SiteSpoke.list();
	const used = new Set(spokes.map((s) => s.ldapServerId).filter(Boolean));
	for (let i = 2; i <= MAX_LDAP_SERVER_ID; i++) {
		if (!used.has(i)) return i;
	}
	throw new Error(`LDAP server ID space exhausted (max ${MAX_LDAP_SERVER_ID} spokes)`);
}

// A site's LDAP replication URL, derived from its already-known HTTP(S)
// endpoint rather than requiring a separately-configured field: same
// hostname, LDAPS port 636 -- exactly the convention docs/replication.md's
// own worked examples already use (ldaps://sso.site2.com:636 alongside
// https://sso.site2.com). No new config an operator has to keep in sync.
function ldapHostFor(endpoint) {
	try {
		const host = new URL(endpoint).hostname;
		return `ldaps://${host}:636`;
	} catch (e) {
		return null;
	}
}

module.exports = { MAX_LDAP_SERVER_ID, nextFreeLdapServerId, ldapHostFor };
