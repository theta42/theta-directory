'use strict';

// Applies OpenLDAP replication config AT RUNTIME, with no restart and no
// operator action.
//
// The problem this exists to remove: replication config is not static. Every
// time a site joins or leaves the cluster, every OTHER site's syncrepl peer
// list changes. The stack used to write a static slapd.conf, which slapd
// reads exactly once at process start, so the only way to apply a change was
// to re-run setup.sh on every site -- an operator ritual nobody performs
// reliably, with silently divergent replication in the meantime.
//
// slapd now runs from the cn=config backend (see docker-entrypoint.sh), which
// makes olcServerID and olcSyncrepl modifiable over ldapmodify while it is
// serving. This module owns that: given the ServerID and peer list the
// cluster currently says this node should have, it converges the running
// config on it.
//
// Convergence, not blind writes: it reads what is configured, computes the
// delta, and issues only the modifications needed. Applying the same desired
// state twice is a no-op, which is what lets it be called freely -- at boot,
// on every spoke registration, on every resync -- without churning slapd.

const { execFile } = require('child_process');
const conf = require('@simpleworkjs/conf');
const { baseDnFrom } = require('./site_join');


const CONFIG_ADMIN_DN = process.env.LDAP_CONFIG_ADMIN_DN || 'cn=admin,cn=config';
const LDAP_URL = process.env.LDAP_LOCAL_URL || 'ldap://localhost:389';
// The config admin credential is the same one the entrypoint hashed into
// cn=config's rootpw: both already grant total control of this slapd, so a
// second secret would add management burden without adding a boundary.
function configAdminCred() {
	return process.env.LDAP_CONFIG_ADMIN_PASS || (conf.ldap && conf.ldap.bindPassword) || '';
}

// syncrepl rids are derived from the peer's ServerID rather than allocated,
// so the same peer always maps to the same rid on every node and a re-apply
// never renumbers anything. 100 + serverId matches the numbering the old
// slapd.conf generator used.
function ridFor(serverId) {
	return 100 + Number(serverId);
}

// Writes `input` to the child's stdin explicitly.
//
// NOT promisify(execFile) with an `input` option: async execFile has no such
// option (only the *Sync variants do), so it is silently ignored and
// ldapmodify sits reading an stdin that never delivers an LDIF, then fails
// with an empty error. The same trap is documented in
// test/multisite_join_e2e.js, which is where it was learned the first time.
function runLdap(cmd, args, input) {
	return new Promise((resolve, reject) => {
		const child = execFile(cmd, args, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
			if (err) {
				err.stdout = stdout;
				err.stderr = stderr;
				return reject(err);
			}
			resolve({ stdout, stderr });
		});
		if (input !== undefined) child.stdin.end(input);
		else child.stdin.end();
	});
}

const ldapArgs = () => ['-x', '-H', LDAP_URL, '-D', CONFIG_ADMIN_DN, '-w', configAdminCred()];

// The DN of the mdb database holding the directory. Found rather than
// assumed: the index in olcDatabase={N}mdb depends on what else is
// configured, and hardcoding {1} breaks the moment that changes.
async function findDatabaseDn() {
	// Matched on objectClass, not on `(olcDatabase=*mdb)`: the stored value is
	// `{1}mdb` and slapd does not substring-match that attribute, so the
	// obvious filter silently returns nothing.
	const { stdout } = await runLdap('ldapsearch', [
		...ldapArgs(), '-LLL', '-b', 'cn=config', '(objectClass=olcMdbConfig)', 'dn', 'olcSuffix'
	]);
	const entries = stdout.split(/\n\n+/);
	const baseDn = baseDnFrom(conf);
	for (const entry of entries) {
		const dn = /^dn:\s*(.+)$/m.exec(entry);
		const suffix = /^olcSuffix:\s*(.+)$/m.exec(entry);
		if (!dn) continue;
		if (!baseDn || !suffix || suffix[1].trim() === baseDn) return dn[1].trim();
	}
	return null;
}

// What slapd is running with right now.
async function readCurrent() {
	const dbDn = await findDatabaseDn();
	if (!dbDn) throw new Error('could not locate the mdb database in cn=config');

	const { stdout: cfg } = await runLdap('ldapsearch', [
		...ldapArgs(), '-LLL', '-b', 'cn=config', '-s', 'base', 'olcServerID'
	]);
	const serverIds = [...cfg.matchAll(/^olcServerID:\s*(.+)$/gm)].map((m) => m[1].trim());

	// Both spellings are requested: OpenLDAP 2.6 renamed mirrormode to
	// multiprovider. It still ACCEPTS olcMirrorMode on write (so that is what
	// this writes, for compatibility with older servers) but STORES and
	// returns olcMultiProvider. Reading only the old name meant this never
	// saw the setting it had just made and rewrote it on every single pass.
	const { stdout: db } = await runLdap('ldapsearch', [
		...ldapArgs(), '-LLL', '-b', dbDn, '-s', 'base',
		'olcSyncrepl', 'olcMirrorMode', 'olcMultiProvider'
	]);
	// Unfold LDIF continuation lines before matching -- a syncrepl value is
	// long and slapd wraps it.
	const unfolded = db.replace(/\n /g, '');
	const syncrepl = [...unfolded.matchAll(/^olcSyncrepl:\s*(.+)$/gm)].map((m) => m[1].trim());
	const mirrorMode = /^olc(MirrorMode|MultiProvider):\s*TRUE$/mi.test(unfolded);

	return { dbDn, serverIds, syncrepl, mirrorMode };
}

// rid -> provider, parsed out of the live olcSyncrepl values so the delta can
// be computed by identity rather than by string equality (slapd normalizes
// and reorders what it stores, so the raw strings never match what we wrote).
function providersByRid(syncreplValues) {
	const out = new Map();
	for (const value of syncreplValues) {
		const rid = /\brid=(\d+)/.exec(value);
		const provider = /\bprovider=(\S+)/.exec(value);
		if (rid && provider) out.set(Number(rid[1]), provider[1].replace(/^"|"$/g, ''));
	}
	return out;
}

// No `{n}` prefix: that position is slapd's to assign (X-ORDERED), and
// supplying the rid there just produces a value that cannot be addressed
// later. The rid lives in the value itself, where it belongs.
function syncreplValue({ rid, provider, baseDn, bindDn, cred }) {
	return `rid=${rid} provider=${provider} type=refreshAndPersist retry="60 +" ` +
		`searchbase="${baseDn}" bindmethod=simple binddn="${bindDn}" credentials="${cred}"`;
}

// Converges the running config on { serverId, peers }.
//
// peers: [{ ldapServerId, ldapHost }] -- every OTHER site in the cluster.
// Returns what changed, so callers can log/report it honestly rather than
// claiming success unconditionally.
async function applyReplicationConfig({ serverId, peers }) {
	const baseDn = baseDnFrom(conf);
	const bindDn = (conf.ldap && conf.ldap.bindDN) || '';
	const cred = (conf.ldap && conf.ldap.bindPassword) || '';
	if (!baseDn || !bindDn) {
		return { applied: false, note: 'no local LDAP base DN / bind DN configured' };
	}
	if (!configAdminCred()) {
		return { applied: false, note: 'no cn=config admin credential available' };
	}

	let current;
	try {
		current = await readCurrent();
	} catch (e) {
		return { applied: false, note: `could not read cn=config: ${e.message}` };
	}

	const changes = [];
	const modifications = [];

	// ── ServerID ────────────────────────────────────────────────────────────
	const wantServerId = String(serverId);
	const haveServerId = current.serverIds.length === 1 ? current.serverIds[0] : null;
	if (serverId && haveServerId !== wantServerId) {
		modifications.push(
			`dn: cn=config\nchangetype: modify\nreplace: olcServerID\nolcServerID: ${wantServerId}\n`
		);
		changes.push(`ServerID ${haveServerId || '(unset)'} -> ${wantServerId}`);
	}

	// ── syncrepl peers ──────────────────────────────────────────────────────
	const have = providersByRid(current.syncrepl);
	const want = new Map();
	for (const peer of peers || []) {
		if (!peer || !peer.ldapServerId || !peer.ldapHost) continue;
		want.set(ridFor(peer.ldapServerId), peer.ldapHost);
	}

	// Additions/removals are expressed as ONE replace of the whole attribute
	// rather than per-value add/delete.
	//
	// olcSyncrepl is X-ORDERED, and the `{n}` prefix slapd stores is the
	// ORDERING POSITION, not the rid: writing `{101}rid=101 ...` comes back as
	// `{0}rid=101 ...`. So deleting a specific peer by `{rid}` fails with "No
	// such attribute", and deleting by position is a moving target (every
	// removal renumbers the ones after it). Replacing the attribute with the
	// full desired set sidesteps both, and stays idempotent because the delta
	// check below only fires it when something actually differs.
	let syncreplChanged = false;
	for (const [rid, provider] of want) {
		if (have.get(rid) === provider) continue;
		changes.push(have.has(rid)
			? `peer rid=${rid}: ${have.get(rid)} -> ${provider}`
			: `peer rid=${rid}: + ${provider}`);
		syncreplChanged = true;
	}
	for (const [rid, provider] of have) {
		if (want.has(rid)) continue;
		changes.push(`peer rid=${rid}: - ${provider}`);
		syncreplChanged = true;
	}

	if (syncreplChanged) {
		// No `{n}` prefix on the values -- slapd assigns the ordering itself.
		const values = [...want.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([rid, provider]) => `olcSyncrepl: ${syncreplValue({ rid, provider, baseDn, bindDn, cred })}`);
		modifications.push(
			`dn: ${current.dbDn}\nchangetype: modify\nreplace: olcSyncrepl\n` +
			(values.length ? values.join('\n') + '\n' : '')
		);
	}

	// ── mirrormode ──────────────────────────────────────────────────────────
	// Required for multi-master; only meaningful once there is a peer to
	// replicate with, and slapd rejects it with no syncrepl configured.
	const wantMirror = want.size > 0;
	if (wantMirror !== current.mirrorMode) {
		modifications.push(
			`dn: ${current.dbDn}\nchangetype: modify\nreplace: olcMirrorMode\nolcMirrorMode: ${wantMirror ? 'TRUE' : 'FALSE'}\n`
		);
		changes.push(`mirrormode -> ${wantMirror}`);
	}

	if (modifications.length === 0) {
		return { applied: true, changed: false, changes: [], note: 'already in sync' };
	}

	// mirrormode must be set AFTER syncrepl exists and cleared BEFORE the last
	// one goes away, so ordering matters: adds first, mirror last when
	// enabling; the reverse when disabling.
	const ordered = wantMirror ? modifications : modifications.slice().reverse();

	try {
		await runLdap('ldapmodify', [...ldapArgs(), '-c'], ordered.join('\n') + '\n');
	} catch (e) {
		const detail = (e.stderr || e.message || '').toString().slice(0, 400);
		return { applied: false, changed: false, changes, note: `ldapmodify failed: ${detail}` };
	}

	return {
		applied: true,
		changed: true,
		changes,
		note: `applied live: ${changes.join('; ')}`
	};
}

module.exports = {
	applyReplicationConfig, readCurrent, findDatabaseDn, providersByRid,
	ridFor, syncreplValue, CONFIG_ADMIN_DN
};
