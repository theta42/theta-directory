'use strict';

const fs = require('fs');

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

// A site's LDAP replication URL over the WireGuard mesh: plain LDAP (389), not
// LDAPS (636). The tunnel is already encrypted end-to-end, so there is no need
// for TLS on top of it, and LDAPS with a certificate bound to a hostname does
// not work over a bare mesh IP anyway. Every site is a mesh node (each is a
// potential exit), so the mesh is the default transport for replication --
// LDAP is never exposed to the public internet.
function ldapMeshHost(siteId) {
	const id = Number(siteId);
	if (!Number.isInteger(id) || id < 1) return null;
	return `ldap://10.${id}.0.2:389`;
}

// A site's LDAP replication URL, derived from its already-known HTTP(S)
// endpoint: same hostname, LDAPS port 636. This is the FALLBACK for a site
// that has no mesh identity yet (e.g. a spoke that registered without an
// assigned ServerID). It is deliberately NOT the default: LDAP must ride the
// WireGuard tunnel, never the public internet.
function ldapHostFor(endpoint) {
	try {
		const host = new URL(endpoint).hostname;
		return `ldaps://${host}:636`;
	} catch (e) {
		return null;
	}
}

// The syncrepl provider URL for a REGISTERED SPOKE.
//
// Every site is a mesh node, so replication rides the tunnel by default: the
// peer's directory is dialled at its mesh address (10.<serverId>.0.2) over
// plain LDAP. This is the same preference utils/site_replicate.js applies to
// resync pushes, and for the same reason -- the WireGuard tunnel is the only
// path that exists for inter-site traffic, and LDAP is never public-facing.
//
// A spoke that has not been assigned a ServerID yet (no mesh identity) falls
// back to its public endpoint, so a partially-registered site still converges
// rather than silently going stale.
function ldapHostForSpoke(spoke) {
	if (!spoke) return null;
	if (spoke.ldapServerId) {
		const mesh = ldapMeshHost(spoke.ldapServerId);
		if (mesh) return mesh;
	}
	return ldapHostFor(spoke.endpoint);
}

const SLAPD_CONF_PATH = process.env.SLAPD_CONF_PATH || '/etc/openldap/slapd.conf';

// The ServerID this node's OpenLDAP is ACTUALLY running with right now, read
// straight from slapd.conf (the same file docker-entrypoint.sh writes
// `ServerID <n>` into). This can genuinely differ from what
// GET /ldap-peers / /ldap-replication-config currently ADVERTISE for this
// node -- OpenLDAP's static slapd.conf is only read at process start, so a
// promotion or a new spoke joining doesn't retroactively change what's
// already running until `setup.sh` restarts the container. Surfaced on the
// Multi-Site modal so an operator can see "configured X, but slapd is still
// running Y" instead of assuming replication is live because the API says so.
function currentSlapdServerId() {
	let contents;
	try {
		contents = fs.readFileSync(SLAPD_CONF_PATH, 'utf8');
	} catch (e) {
		return null;
	}
	const m = contents.match(/^ServerID\s+(\d+)/m);
	return m ? Number(m[1]) : null;
}

// The replication providers this node's slapd is ACTUALLY running with.
//
// Reads the slapd.conf SEED, which is only the starting point now: slapd runs
// from the cn=config backend and utils/ldap_reconcile.js applies peer changes
// live, so the file lags the running server by design. This is the offline
// fallback for the async reader below (and for tests); anything reporting
// status to an operator should prefer currentReplicationState().
function currentSlapdPeers() {
	let contents;
	try {
		contents = fs.readFileSync(SLAPD_CONF_PATH, 'utf8');
	} catch (e) {
		return null;
	}
	const hosts = [...contents.matchAll(/^\s*provider=(\S+)/gm)].map((m) => m[1]);
	return [...new Set(hosts)];
}

// What slapd is running with RIGHT NOW, straight out of cn=config. Falls back
// to the slapd.conf seed if cn=config can't be read (an older deployment that
// hasn't been rebuilt onto the dynamic backend yet, or a broken config bind),
// so status never goes blank on an upgrade.
async function currentReplicationState() {
	try {
		const { readCurrent, providersByRid } = require('./ldap_runtime_config');
		const live = await readCurrent();
		return {
			source: 'cn=config',
			serverId: live.serverIds.length === 1 ? Number(live.serverIds[0]) : null,
			peers: [...providersByRid(live.syncrepl).values()]
		};
	} catch (e) {
		return {
			source: 'slapd.conf',
			serverId: currentSlapdServerId(),
			peers: currentSlapdPeers(),
			note: 'could not read the live cn=config; showing the boot-time seed'
		};
	}
}

// Compares what slapd is running with against what the cluster currently
// says this node should have.
//
// This used to be the ONLY answer to a real problem: peer lists went stale on
// every node each time a site joined, and applying the fix meant an operator
// re-running setup.sh everywhere. That is no longer how it works --
// utils/ldap_reconcile.js applies replication config live against cn=config
// on every event that changes it. So drift should now always read as false,
// and this is a SAFETY NET rather than an instruction: if it ever reports
// stale, something in the automatic path failed (a node that couldn't reach
// its master, an ldapmodify that was rejected) and that is worth surfacing
// loudly rather than hiding.
//
// Pass `state` (from currentReplicationState()) to compare against the LIVE
// config; without it this falls back to the slapd.conf seed, which lags by
// design.
function replicationDrift({ advertisedServerId, advertisedPeers, state }) {
	const configuredServerId = state ? state.serverId : currentSlapdServerId();
	const configuredPeers = state ? state.peers : currentSlapdPeers();
	const expected = (advertisedPeers || []).map((p) => p.ldapHost).filter(Boolean);

	// null (not []) means slapd.conf couldn't be read at all -- "can't tell",
	// which the UI must not render as "everything matches".
	if (configuredPeers === null) {
		return {
			configuredServerId, configuredPeers: null, expectedPeers: expected,
			serverIdStale: null, peersStale: null, stale: null,
			missingPeers: [], extraPeers: []
		};
	}

	const configuredSet = new Set(configuredPeers);
	const expectedSet = new Set(expected);
	const missingPeers = expected.filter((h) => !configuredSet.has(h));
	const extraPeers = configuredPeers.filter((h) => !expectedSet.has(h));
	const serverIdStale = configuredServerId !== null && advertisedServerId != null
		? configuredServerId !== advertisedServerId
		: null;
	const peersStale = missingPeers.length > 0 || extraPeers.length > 0;

	return {
		configuredServerId,
		configuredPeers,
		expectedPeers: expected,
		serverIdStale,
		peersStale,
		stale: !!serverIdStale || peersStale,
		missingPeers,
		extraPeers
	};
}

module.exports = {
	MAX_LDAP_SERVER_ID, nextFreeLdapServerId, ldapMeshHost, ldapHostFor, ldapHostForSpoke,
	currentSlapdServerId, currentSlapdPeers, currentReplicationState, replicationDrift
};
