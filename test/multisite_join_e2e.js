'use strict';

// End-to-end test of the real, shipped multi-site join flow (docs/site-join.md).
// Drives the actual HTTP API two humans (a master admin + a spoke admin)
// would use: seed an admin on each side, mint a site join key on master,
// have the spoke adopt it, and verify the post-join contract holds.

const { execFileSync } = require('child_process');
const crypto = require('crypto');

// Wrapper matching the async call sites below (execFileSync throws
// synchronously; wrap in a resolved/rejected promise so callers can keep
// using await/.catch()). NOTE: plain execFile (async) does NOT support the
// `input` option for piping stdin -- only the *Sync variants do -- so
// ldapadd/ldapmodify would otherwise hang forever waiting on stdin that never
// arrives. This bit us once already; don't switch back to async execFile here
// without adding real stdin piping.
function execFileAsync(cmd, args, opts) {
  try {
    const stdout = execFileSync(cmd, args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    return Promise.resolve({ stdout: stdout ? stdout.toString() : '' });
  } catch (e) {
    e.stderr = e.stderr ? e.stderr.toString() : '';
    return Promise.reject(e);
  }
}

const MASTER_URL = process.env.MASTER_URL || 'http://master:3001';
const SPOKE_URL = process.env.SPOKE_URL || 'http://spoke:3001';
const MASTER_LDAP_HOST = process.env.MASTER_LDAP_HOST || 'master';
const MASTER_BASE_DN = process.env.MASTER_BASE_DN || 'dc=master,dc=test';
const SPOKE_LDAP_HOST = process.env.SPOKE_LDAP_HOST || 'spoke';
const SPOKE_BASE_DN = process.env.SPOKE_BASE_DN || 'dc=spoke,dc=test';
const SPOKE2_URL = process.env.SPOKE2_URL || 'http://spoke2:3001';
const SPOKE2_LDAP_HOST = process.env.SPOKE2_LDAP_HOST || 'spoke2';
const SPOKE2_BASE_DN = process.env.SPOKE2_BASE_DN || 'dc=spoke2,dc=test';
const LDAP_ADMIN_PASS = process.env.LDAP_ADMIN_PASS || 'secret';
const ADMIN_UID = 'e2eadmin';
const ADMIN_PASSWORD = 'MultiSiteE2E!2';

let failed = false;
function fail(msg) {
  console.error('MULTISITE E2E FAIL:', msg);
  failed = true;
}
function step(msg) {
  console.log('--- ' + msg);
}

// Dereferencing `body.config` (or any other expected key) straight off a
// response turns every non-200 into `TypeError: Cannot read properties of
// undefined`, which says nothing about what actually came back. That happened
// for real: a CI failure at the post-join status check reported only the
// TypeError, with no status, no body, and no matching line in the server's own
// log to correlate against. Fail with the evidence instead.
function expectShape(label, res, key) {
  if (res && res.status === 200 && res.body && res.body[key] !== undefined) return res.body[key];
  fail(`${label}: expected HTTP 200 with a '${key}' field, got HTTP ${res && res.status} ${JSON.stringify(res && res.body)}`);
  return undefined;
}

// A read that immediately follows a replication-config change, retried for a
// bounded window.
//
// Authorization on these routes resolves group membership LIVE from the local
// slapd, and a join has just done two things to it: imported the master's
// whole tree, and switched on syncrepl + mirrormode. While that initial
// refresh runs, the admin's group entry is being rewritten underneath the
// lookup, so an admin request can transiently come back 403 "admin only"
// before settling. Seen for real: the same commit failed one CI run here and
// passed another.
//
// This is NOT covering for a broken assertion -- what is being asserted is
// that the spoke persisted isMaster:false, and a brief authorization blip
// during the initial refresh is expected behaviour of the system under test,
// not a property this step is about. A hard failure still happens if the
// window expires.
async function apiEventually(label, url, path, opts, key, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let res;
  for (;;) {
    res = await api(url, path, opts);
    if (res.status === 200 && res.body && (key === undefined || res.body[key] !== undefined)) {
      return key === undefined ? res.body : res.body[key];
    }
    const retriable = res.status === 401 || res.status === 403 || res.status >= 500;
    if (!retriable || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return expectShape(label, res, key);
}

async function waitForHealthy(url, label) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch (_) { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`${label} never became healthy`);
}

// Seed an admin user directly via ldapadd/ldapmodify -- mirrors
// test/seed-test-user.sh, but parameterized per-site since master and spoke
// have distinct base DNs in this harness.
async function seedAdmin(ldapHost, baseDn) {
  const salt = crypto.randomBytes(8);
  const digest = crypto.createHash('sha512').update(ADMIN_PASSWORD).update(salt).digest();
  const hash = '{SSHA512}' + Buffer.concat([digest, salt]).toString('base64');

  const ldif = `
dn: cn=${ADMIN_UID},ou=groups,${baseDn}
objectClass: posixGroup
objectClass: top
cn: ${ADMIN_UID}
gidNumber: 1600

dn: cn=${ADMIN_UID},ou=people,${baseDn}
objectClass: inetOrgPerson
objectClass: posixAccount
objectClass: top
objectClass: theta42Person
objectClass: ldapPublicKey
objectClass: sudoRole
cn: ${ADMIN_UID}
sn: E2E
uid: ${ADMIN_UID}
uidNumber: 1600
gidNumber: 1600
homeDirectory: /home/${ADMIN_UID}
loginShell: /bin/bash
mail: ${ADMIN_UID}@test.local
userPassword: ${hash}
`.trim() + '\n';

  const bindDn = `cn=admin,${baseDn}`;
  await execFileAsync('ldapadd', ['-x', '-H', `ldap://${ldapHost}:389`, '-D', bindDn, '-w', LDAP_ADMIN_PASS], { input: ldif })
    .catch((e) => { if (!/Already exists/.test(e.stderr || '')) throw e; });

  // god_admin is needed for site-promote (SUPER_ADMIN_GROUP, utils/permission.js).
  for (const group of ['app_sso_admin', 'god_admin']) {
    const modLdif = `dn: cn=${group},ou=groups,${baseDn}\nchangetype: modify\nadd: member\nmember: cn=${ADMIN_UID},ou=people,${baseDn}\n`;
    try {
      await execFileAsync('ldapmodify', ['-x', '-H', `ldap://${ldapHost}:389`, '-D', bindDn, '-w', LDAP_ADMIN_PASS], { input: modLdif });
      console.log(`    (added ${ADMIN_UID} to ${group} on ${ldapHost})`);
    } catch (e) {
      if (!/[Tt]ype or value exists/.test(e.stderr || '')) {
        console.error(`    FAILED adding ${ADMIN_UID} to ${group} on ${ldapHost}: ${e.stderr || e.message}`);
        throw e;
      }
      console.log(`    (${ADMIN_UID} already in ${group} on ${ldapHost})`);
    }
  }

  const verify = await execFileAsync('ldapsearch', ['-x', '-H', `ldap://${ldapHost}:389`, '-D', bindDn, '-w', LDAP_ADMIN_PASS,
    '-b', `cn=god_admin,ou=groups,${baseDn}`, 'member']);
  console.log(`    god_admin members on ${ldapHost}:\n${verify.stdout}`);
}

async function login(url) {
  const r = await fetch(`${url}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: ADMIN_UID, password: ADMIN_PASSWORD })
  });
  if (!r.ok) throw new Error(`login at ${url} failed: ${r.status} ${await r.text()}`);
  const body = await r.json();
  return body.token;
}

async function api(url, path, { method = 'GET', token, body } = {}) {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'auth-token': token } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch (_) { json = { raw: text }; }
  return { status: r.status, body: json };
}

async function main() {
  step('Waiting for master + both spokes to be healthy');
  await waitForHealthy(MASTER_URL, 'master');
  await waitForHealthy(SPOKE_URL, 'spoke');
  await waitForHealthy(SPOKE2_URL, 'spoke2');

  step('Seeding admin users in all three sites\' LDAP');
  await seedAdmin(MASTER_LDAP_HOST, MASTER_BASE_DN);
  await seedAdmin(SPOKE_LDAP_HOST, SPOKE_BASE_DN);
  await seedAdmin(SPOKE2_LDAP_HOST, SPOKE2_BASE_DN);

  step('Logging in as admin on master and spoke');
  const masterToken = await login(MASTER_URL);
  const spokeToken = await login(SPOKE_URL);
  if (!masterToken) fail('no token from master login');
  if (!spokeToken) fail('no token from spoke login');

  step('Confirming both sites start as master (fresh installs)');
  {
    const { body } = await api(MASTER_URL, '/api/site/config', { token: masterToken });
    if (body.config.isMaster !== true) fail(`expected master to start isMaster:true, got ${JSON.stringify(body.config)}`);
  }
  {
    const { body } = await api(SPOKE_URL, '/api/site/config', { token: spokeToken });
    if (body.config.isMaster !== true) fail(`expected spoke to start isMaster:true (pre-join), got ${JSON.stringify(body.config)}`);
  }

  step('Creating a resource on master BEFORE join, to verify it gets adopted');
  // Only site resources can be top-level; a host needs a parent site.
  const siteRes = await api(MASTER_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: masterToken,
    body: { name: 'E2E Site', slug: 'site_e2e', kind: 'site' }
  });
  if (siteRes.status !== 200) fail(`seeding pre-join site on master failed: ${siteRes.status} ${JSON.stringify(siteRes.body)}`);

  step('Verifying the Directory site Resource\'s slug synced into the multi-site replication identity');
  const { body: masterCfgAfterSite } = await api(MASTER_URL, '/api/site/config', { token: masterToken });
  if (masterCfgAfterSite.config.siteSlug !== 'site_e2e') {
    fail(`expected site_config's siteSlug to sync to the new site Resource's slug (site_e2e), got ${JSON.stringify(masterCfgAfterSite.config.siteSlug)}`);
  }

  const seedRes = await api(MASTER_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: masterToken,
    body: { name: 'E2E Pre-Join Host', slug: 'host_e2e_prejoin', kind: 'host', parentSlug: 'site_e2e' }
  });
  if (seedRes.status !== 200) fail(`seeding pre-join resource on master failed: ${seedRes.status} ${JSON.stringify(seedRes.body)}`);

  step('Minting a site join key on master');
  const keyRes = await api(MASTER_URL, '/api/site/join-keys', {
    method: 'POST',
    token: masterToken,
    body: { label: 'e2e-test' }
  });
  if (keyRes.status !== 200 || !keyRes.body.key) fail(`join-key mint failed: ${keyRes.status} ${JSON.stringify(keyRes.body)}`);
  const joinKey = keyRes.body.key;

  step('Joining spoke to master (with selfUrl, to register for live replication)');
  const joinRes = await api(SPOKE_URL, '/api/site/join', {
    method: 'POST',
    token: spokeToken,
    // master's own container-internal URL, as the spoke would reach it over the network
    body: { masterUrl: 'http://master:3001', joinKey, selfUrl: 'http://spoke:3001' }
  });
  if (joinRes.status !== 200) fail(`join failed: ${joinRes.status} ${JSON.stringify(joinRes.body)}`);
  if (!joinRes.body.replication || joinRes.body.replication.live !== true) {
    fail(`expected join to register for live replication, got ${JSON.stringify(joinRes.body.replication)}`);
  }

  // The join reported "skipped/failed" for the LDAP tree on EVERY join and
  // resync -- a callback-style fs.unlink() throwing into the catch that sets
  // this note, after ldapadd had already succeeded. Nothing asserted the note,
  // so it went unnoticed; assert it now.
  step('Verifying the join reports the LDAP tree as actually imported');
  if (!joinRes.body.ldap || !/^imported/.test(joinRes.body.ldap.note || '')) {
    fail(`expected join to report an "imported..." ldap.note, got ${JSON.stringify(joinRes.body.ldap)}`);
  }

  // Assert on the LDAP tree itself, not just the note: the note is what hid
  // "spawn -c ENOENT" (argv[0] was missing, so ldapadd never ran) for as long
  // as it did. Seed a user on the master, resync, and look for it in the
  // spoke's own slapd.
  step('Verifying a master-only LDAP user actually lands in the spoke\'s directory');
  const replicatedUid = 'e2erepl';
  await execFileAsync('ldapadd', ['-x', '-H', `ldap://${MASTER_LDAP_HOST}:389`, '-D', `cn=admin,${MASTER_BASE_DN}`, '-w', LDAP_ADMIN_PASS], {
    input: `dn: uid=${replicatedUid},ou=people,${MASTER_BASE_DN}
objectClass: inetOrgPerson
objectClass: posixAccount
uid: ${replicatedUid}
cn: E2E Replicated User
sn: User
uidNumber: 21001
gidNumber: 21001
homeDirectory: /home/${replicatedUid}
`
  }).catch((e) => {
    if (!/Already exists/i.test(e.stderr || '')) fail(`seeding a master-only LDAP user failed: ${e.stderr || e.message}`);
  });

  // A resync (which re-pulls the export, LDIF included) fires on any master
  // catalog write, so make one rather than reaching for the push token.
  const nudge = await api(MASTER_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: masterToken,
    body: { name: 'E2E LDAP Nudge', slug: 'host_e2e_ldap_nudge', kind: 'host', parentSlug: 'site_e2e' }
  });
  if (nudge.status !== 200) fail(`could not trigger a resync via a master write: ${nudge.status} ${JSON.stringify(nudge.body)}`);

  let ldapReplicated = false;
  for (let i = 0; i < 20; i++) {
    const out = await execFileAsync('ldapsearch', [
      '-x', '-H', `ldap://${SPOKE_LDAP_HOST}:389`, '-D', `cn=admin,${SPOKE_BASE_DN}`, '-w', LDAP_ADMIN_PASS,
      '-b', `ou=people,${SPOKE_BASE_DN}`, `(uid=${replicatedUid})`, 'uid'
    ]).catch(() => ({ stdout: '' }));
    if ((out.stdout || '').includes(`uid: ${replicatedUid}`)) { ldapReplicated = true; break; }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!ldapReplicated) {
    fail('a user that exists only on the master never appeared in the spoke\'s LDAP -- the join\'s LDIF import is not working');
  }

  step('Verifying spoke persisted isMaster:false + masterUrl after join');
  const spokeCfgBody = await apiEventually(
    'spoke /api/site/config after join', SPOKE_URL, '/api/site/config', { token: spokeToken }, 'config'
  );
  if (spokeCfgBody) {
    if (spokeCfgBody.isMaster !== false) fail(`spoke should be isMaster:false after join, got ${JSON.stringify(spokeCfgBody)}`);
    if (!spokeCfgBody.masterUrl) fail('spoke should have masterUrl set after join');
  }

  step('Verifying the master computed its own LDAP replication config (ServerID 1 + the new spoke as a peer)');
  const { body: masterLdapCfg } = await api(MASTER_URL, '/api/directory-admin/ldap-replication-config', { token: masterToken });
  if (masterLdapCfg.ldapServerId !== 1) fail(`master's own ldapServerId should be 1, got ${JSON.stringify(masterLdapCfg)}`);
  // Replication rides the WireGuard mesh: a peer's directory is dialled at its
  // mesh address over plain LDAP, never the public endpoint.
  const spokePeer = (masterLdapCfg.peers || []).find(p => p.ldapHost === 'ldap://10.2.0.2:389');
  if (!spokePeer || typeof spokePeer.ldapServerId !== 'number') {
    fail(`master's peer list should include the spoke at ldap://10.2.0.2:389 with an assigned ldapServerId, got ${JSON.stringify(masterLdapCfg.peers)}`);
  }

  step('Verifying the spoke can fetch its own assigned LDAP ServerID + peer list from the master');
  const spokeLdapPeersResp = await fetch(`${MASTER_URL}/api/site/ldap-peers?endpoint=${encodeURIComponent('http://spoke:3001')}`, {
    headers: { Authorization: 'Bearer ' + joinKey }
  });
  const spokeLdapCfg = await spokeLdapPeersResp.json();
  if (spokeLdapPeersResp.status !== 200) fail(`GET /api/site/ldap-peers failed: ${spokeLdapPeersResp.status} ${JSON.stringify(spokeLdapCfg)}`);
  if (spokeLdapCfg.ldapServerId !== spokePeer.ldapServerId) {
    fail(`spoke's own reported ldapServerId (${spokeLdapCfg.ldapServerId}) should match what the master's peer list assigned it (${spokePeer.ldapServerId})`);
  }
  const masterAsPeer = (spokeLdapCfg.peers || []).find(p => p.ldapServerId === 1);
  if (!masterAsPeer || masterAsPeer.ldapHost !== 'ldap://10.1.0.2:389') {
    fail(`spoke's peer list should include the master (ServerID 1, ldap://10.1.0.2:389), got ${JSON.stringify(spokeLdapCfg.peers)}`);
  }
  const selfInOwnPeerList = (spokeLdapCfg.peers || []).some(p => p.ldapServerId === spokeLdapCfg.ldapServerId);
  if (selfInOwnPeerList) fail(`spoke's own peer list should not include itself, got ${JSON.stringify(spokeLdapCfg.peers)}`);

  step('Verifying the master\'s own site-status surfaces LDAP status + per-spoke detail (Multi-Site modal data)');
  const { body: masterStatus } = await api(MASTER_URL, '/api/directory-admin/site-status', { token: masterToken });
  if (!masterStatus.ldap || masterStatus.ldap.advertisedServerId !== 1) {
    fail(`master's site-status should report ldap.advertisedServerId 1, got ${JSON.stringify(masterStatus.ldap)}`);
  }
  if (masterStatus.ldap.peersCount !== 1) {
    fail(`master's site-status should report exactly 1 LDAP peer (the spoke), got ${JSON.stringify(masterStatus.ldap)}`);
  }
  const statusSpokeEntry = (masterStatus.spokes || []).find(s => s.endpoint === 'http://spoke:3001');
  if (!statusSpokeEntry || typeof statusSpokeEntry.ldapServerId !== 'number') {
    fail(`master's site-status spokes list should include the spoke with an ldapServerId, got ${JSON.stringify(masterStatus.spokes)}`);
  }

  step('Verifying the spoke adopted the master\'s pre-join catalog');
  const spokeResources = await api(SPOKE_URL, '/api/directory-admin/resources', { token: spokeToken });
  const adopted = (spokeResources.body.results || spokeResources.body.resources || spokeResources.body || []);
  const found = Array.isArray(adopted) && adopted.some(r => r.slug === 'host_e2e_prejoin');
  if (!found) fail(`spoke did not adopt master's pre-join resource; got slugs=${JSON.stringify((adopted || []).map(r => r.slug))}`);

  // Transparent write-forwarding (MULTI_SITE_SPEC.md §2.1). This step used to
  // assert a 403, which was correct before hub-and-spoke: a spoke rejected
  // directory writes outright. Since then a spoke FORWARDS them to the master,
  // so 403 is the wrong expectation -- and asserting it would have gone on
  // passing for the entirely wrong reason, because the middleware that does
  // the forwarding was itself broken (its path rules never matched) and the
  // local read-only gate answered instead.
  //
  // So this asserts the property the design actually promises, which is
  // stronger: the write SUCCEEDS at the spoke, and it lands on the MASTER --
  // single write authority, with the spoke's copy arriving by replication.
  step('Verifying a directory write on the spoke is forwarded to the master and committed there');
  const forwardedWrite = await api(SPOKE_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: spokeToken,
    body: { name: 'E2E Forwarded Host', slug: 'host_e2e_forwarded', kind: 'host', parentSlug: 'site_e2e' }
  });
  if (forwardedWrite.status !== 200) {
    fail(`expected a spoke directory write to be forwarded and accepted, got ${forwardedWrite.status} ${JSON.stringify(forwardedWrite.body)}`);
  }
  {
    const onMaster = await api(MASTER_URL, '/api/directory-admin/resources', { token: masterToken });
    const slugs = (onMaster.body.results || onMaster.body.resources || onMaster.body || []).map((x) => x.slug);
    if (!slugs.includes('host_e2e_forwarded')) {
      fail(`a write made at the spoke did not reach the master -- it was committed locally instead. master slugs=${JSON.stringify(slugs)}`);
    }
  }

  step('Creating a resource on master AFTER join, to verify LIVE replication (not just the one-time join snapshot)');
  const postJoinRes = await api(MASTER_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: masterToken,
    body: { name: 'E2E Post-Join Host', slug: 'host_e2e_postjoin', kind: 'host', parentSlug: 'site_e2e' }
  });
  if (postJoinRes.status !== 200) fail(`creating post-join resource on master failed: ${postJoinRes.status} ${JSON.stringify(postJoinRes.body)}`);

  step('Waiting for the fire-and-forget resync push to reach the spoke');
  let liveReplicated = false;
  for (let i = 0; i < 20; i++) {
    const r = await api(SPOKE_URL, '/api/directory-admin/resources', { token: spokeToken });
    const slugs = (r.body.results || r.body.resources || r.body || []).map((x) => x.slug);
    if (slugs.includes('host_e2e_postjoin')) { liveReplicated = true; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!liveReplicated) fail('post-join resource never appeared on the spoke -- live replication did not fire (or resync did not apply it)');

  // Resource UPDATES (as opposed to creations) went nowhere: importDirectory
  // called Resource.update(id, data), a static @simpleworkjs/orm has never
  // had, and the TypeError landed in a swallowing catch. A rename on the
  // master therefore never reached any spoke.
  step('Renaming a resource on master to verify UPDATES replicate, not just creations');
  const renameRes = await api(MASTER_URL, '/api/directory-admin/resources', { token: masterToken });
  const allMasterResources = (renameRes.body.results || renameRes.body.resources || renameRes.body || []);
  const toRename = allMasterResources.find((r) => r.slug === 'host_e2e_prejoin');
  const parentSite = allMasterResources.find((r) => r.slug === 'site_e2e');
  if (!toRename || !parentSite) {
    fail('could not find host_e2e_prejoin (or its parent site) on master to rename');
  } else {
    // PUT /resources/:id re-validates the whole body, so kind + hostId have to
    // ride along -- a name-only body is rejected as a top-level non-site.
    const updateRes = await api(MASTER_URL, `/api/directory-admin/resources/${toRename.id}`, {
      method: 'PUT',
      token: masterToken,
      body: { name: 'E2E Renamed Host', kind: 'host', hostId: parentSite.id }
    });
    if (updateRes.status !== 200) fail(`renaming resource on master failed: ${updateRes.status} ${JSON.stringify(updateRes.body)}`);

    let renameReplicated = false;
    for (let i = 0; i < 20; i++) {
      const r = await api(SPOKE_URL, '/api/directory-admin/resources', { token: spokeToken });
      const row = (r.body.results || r.body.resources || r.body || []).find((x) => x.slug === 'host_e2e_prejoin');
      if (row && row.name === 'E2E Renamed Host') { renameReplicated = true; break; }
      await new Promise((res) => setTimeout(res, 500));
    }
    if (!renameReplicated) {
      fail('a rename on the master never reached the spoke -- resource UPDATES are not replicating');
    }
  }

  // The mirror-image half: edge REMOVALS never propagated either, because the
  // edge-clearing loop threw on ResourceEdge.delete(id) and aborted.
  step('Deleting a resource on master to verify removals/edges converge on the spoke');
  const delTarget = (await api(MASTER_URL, '/api/directory-admin/resources', { token: masterToken }))
    .body;
  const postJoinRow = (delTarget.results || delTarget.resources || delTarget || [])
    .find((r) => r.slug === 'host_e2e_postjoin');
  if (postJoinRow) {
    const delRes = await api(MASTER_URL, `/api/directory-admin/resources/${postJoinRow.id}`, {
      method: 'DELETE', token: masterToken
    });
    if (delRes.status !== 200) {
      fail(`deleting resource on master failed: ${delRes.status} ${JSON.stringify(delRes.body)}`);
    } else {
      let deletionConverged = false;
      for (let i = 0; i < 20; i++) {
        const r = await api(SPOKE_URL, '/api/directory-admin/resources', { token: spokeToken });
        const slugs = (r.body.results || r.body.resources || r.body || []).map((x) => x.slug);
        if (!slugs.includes('host_e2e_postjoin')) { deletionConverged = true; break; }
        await new Promise((res) => setTimeout(res, 500));
      }
      if (!deletionConverged) {
        fail('a resource deleted on the master is still present on the spoke -- deletions are not converging');
      }
    }
  }

  step('Verifying WAN health ping from spoke to master succeeds');
  const statusRes = await api(SPOKE_URL, '/api/directory-admin/site-status', { token: spokeToken });
  if (statusRes.body.config && statusRes.body.config.wanConnected !== true) {
    fail(`expected spoke to report wanConnected:true post-join, got ${JSON.stringify(statusRes.body.config)}`);
  }

  step('Verifying master itself is unaffected (still isMaster:true, no writes blocked)');
  const { body: masterCfg } = await api(MASTER_URL, '/api/site/config', { token: masterToken });
  if (masterCfg.config.isMaster !== true) fail('master flipped away from isMaster:true unexpectedly');

  // ── Third site ────────────────────────────────────────────────────────────
  // Everything above works in a two-site cluster. The promotion handoff does
  // not: the promoted node was a spoke, so its own registry is empty, and
  // nothing told the OTHER spokes that the master had changed.
  step('Joining a SECOND spoke to the master (three-site cluster)');
  const spoke2Token = await login(SPOKE2_URL);
  if (!spoke2Token) fail('no token from spoke2 login');

  const key2Res = await api(MASTER_URL, '/api/site/join-keys', {
    method: 'POST', token: masterToken, body: { label: 'e2e-test-spoke2' }
  });
  if (key2Res.status !== 200 || !key2Res.body.key) fail(`second join-key mint failed: ${key2Res.status} ${JSON.stringify(key2Res.body)}`);

  const join2Res = await api(SPOKE2_URL, '/api/site/join', {
    method: 'POST',
    token: spoke2Token,
    body: { masterUrl: 'http://master:3001', joinKey: key2Res.body.key, selfUrl: 'http://spoke2:3001' }
  });
  if (join2Res.status !== 200) fail(`spoke2 join failed: ${join2Res.status} ${JSON.stringify(join2Res.body)}`);
  if (!join2Res.body.replication || join2Res.body.replication.live !== true) {
    fail(`expected spoke2 to register for live replication, got ${JSON.stringify(join2Res.body.replication)}`);
  }

  // The point of moving slapd onto cn=config: a site joining has to change
  // every other site's LIVE replication config, with no setup.sh re-run and
  // no restart. Read it straight out of the running slapd, not out of an API
  // that could just be echoing intent back.
  step('Verifying the master\'s RUNNING slapd picked up both spokes automatically');
  let liveSyncrepl = '';
  for (let i = 0; i < 30; i++) {
    const out = await execFileAsync('ldapsearch', [
      '-x', '-H', `ldap://${MASTER_LDAP_HOST}:389`, '-D', 'cn=admin,cn=config', '-w', LDAP_ADMIN_PASS,
      '-LLL', '-b', 'cn=config', '(olcSyncrepl=*)', 'olcSyncrepl'
    ]).catch((e) => ({ stdout: '', err: e.stderr || e.message }));
    // Unfold LDIF continuation lines before matching. Replication rides the
    // mesh, so peers appear at their mesh addresses over plain LDAP.
    liveSyncrepl = (out.stdout || '').replace(/\n /g, '');
    if (liveSyncrepl.includes('10.2.0.2:389') && liveSyncrepl.includes('10.3.0.2:389')) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!liveSyncrepl.includes('ldap://10.2.0.2:389')) {
    fail(`the master's live slapd has no syncrepl entry for the first spoke -- replication config is not being applied automatically. Got: ${liveSyncrepl.slice(0, 500)}`);
  }
  if (!liveSyncrepl.includes('ldap://10.3.0.2:389')) {
    fail(`the master's live slapd never picked up the SECOND spoke -- this is the case that used to need a setup.sh re-run. Got: ${liveSyncrepl.slice(0, 500)}`);
  }

  step('Verifying the master reports no replication drift (the automatic path worked)');
  const driftStatus = await apiEventually('master site-status drift', MASTER_URL, '/api/directory-admin/site-status', { token: masterToken }, undefined, 20000) || {};
  if (driftStatus.ldap && driftStatus.ldap.source !== 'cn=config') {
    fail(`site-status should read the live cn=config, got source=${JSON.stringify(driftStatus.ldap && driftStatus.ldap.source)}`);
  }
  if (driftStatus.ldap && driftStatus.ldap.stale === true) {
    fail(`master reports replication drift after automatic reconciliation: ${JSON.stringify(driftStatus.ldap)}`);
  }

  step('Verifying the spoke applied ITS assigned ServerID live, without a restart');
  let spokeServerId = '';
  for (let i = 0; i < 20; i++) {
    const out = await execFileAsync('ldapsearch', [
      '-x', '-H', `ldap://${SPOKE_LDAP_HOST}:389`, '-D', 'cn=admin,cn=config', '-w', LDAP_ADMIN_PASS,
      '-LLL', '-b', 'cn=config', '-s', 'base', 'olcServerID'
    ]).catch(() => ({ stdout: '' }));
    spokeServerId = (out.stdout || '').replace(/\n /g, '');
    if (/olcServerID:\s*\d+/.test(spokeServerId)) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (!/olcServerID:\s*[2-9]\d*/.test(spokeServerId)) {
    fail(`the spoke's live slapd should carry the ServerID the master assigned it (>= 2), got: ${JSON.stringify(spokeServerId.trim())}`);
  }

  step('Verifying the master now reports two registered spokes');
  const twoSpokeStatus = await apiEventually('master site-status 2 spokes', MASTER_URL, '/api/directory-admin/site-status', { token: masterToken }, undefined, 20000) || {};
  if (!twoSpokeStatus.config || twoSpokeStatus.config.registeredSpokesCount !== 2) {
    fail(`expected master to report 2 registered spokes, got ${JSON.stringify(twoSpokeStatus.config && twoSpokeStatus.config.registeredSpokesCount)}`);
  }

  // Operator actions on the Registered Spokes table (it used to be read-only,
  // so a dead site's row sat there forever holding an LDAP ServerID).
  step('Forcing a manual resync push at every registered spoke');
  const manualResync = await api(MASTER_URL, '/api/site/spokes/resync', { method: 'POST', token: masterToken, body: {} });
  if (manualResync.status !== 200) fail(`manual resync failed: ${manualResync.status} ${JSON.stringify(manualResync.body)}`);
  if (manualResync.body.ok !== 2 || manualResync.body.failed !== 0) {
    fail(`expected a manual resync to reach both spokes, got ${JSON.stringify(manualResync.body)}`);
  }

  step('Removing a spoke from the registry, then re-registering it');
  const beforeRemoval = await apiEventually('master site-status before removal', MASTER_URL, '/api/directory-admin/site-status', { token: masterToken }, undefined, 20000) || {};
  const spoke2Row = (beforeRemoval.spokes || []).find((s) => s.endpoint === 'http://spoke2:3001');
  if (!spoke2Row || !spoke2Row.id) {
    fail(`site-status must expose a spoke id for the table's actions, got ${JSON.stringify(beforeRemoval.spokes)}`);
  } else {
    const removeRes = await api(MASTER_URL, `/api/site/spokes/${spoke2Row.id}`, { method: 'DELETE', token: masterToken });
    if (removeRes.status !== 200) fail(`removing a spoke failed: ${removeRes.status} ${JSON.stringify(removeRes.body)}`);

    const afterRemoval = await apiEventually('master site-status after removal', MASTER_URL, '/api/directory-admin/site-status', { token: masterToken }, undefined, 20000) || {};
    if (!afterRemoval.config || afterRemoval.config.registeredSpokesCount !== 1) {
      fail(`expected 1 registered spoke after removal, got ${afterRemoval.config.registeredSpokesCount}`);
    }

    // Put it back, the way an operator actually recovers from this: the SPOKE
    // re-registers itself with the master credentials it already holds. A
    // removal recreates the row with a fresh pushToken, so anything driving
    // this from the master's side would leave the two ends disagreeing about
    // the token with no way back (POST /join refuses once a node is a spoke).
    const reReg = await api(SPOKE2_URL, '/api/site/reregister', { method: 'POST', token: spoke2Token });
    if (reReg.status !== 200) fail(`spoke re-registration failed: ${reReg.status} ${JSON.stringify(reReg.body)}`);
    if (reReg.body.live !== true) fail(`re-registration should restore live replication, got ${JSON.stringify(reReg.body)}`);

    const { body: afterRejoin } = await api(MASTER_URL, '/api/directory-admin/site-status', { token: masterToken });
    if (afterRejoin.config.registeredSpokesCount !== 2) {
      fail(`expected 2 registered spokes after re-registration, got ${afterRejoin.config.registeredSpokesCount}`);
    }
  }

  step('Promoting the spoke to master (coordinated handoff -- must demote the old master too)');
  const promoteRes = await api(SPOKE_URL, '/api/directory-admin/site-promote', {
    method: 'POST',
    token: spokeToken,
    body: { selfUrl: 'http://spoke:3001' }
  });
  if (promoteRes.status !== 200) fail(`promotion failed: ${promoteRes.status} ${JSON.stringify(promoteRes.body)}`);
  if (promoteRes.body.handoff !== 'previous master demoted') {
    fail(`expected the old master to be demoted as part of promotion, got handoff=${JSON.stringify(promoteRes.body.handoff)}`);
  }
  if (!promoteRes.body.ldapReplicationNote) {
    fail('expected /site-promote to surface a note that this node\'s LDAP ServerID needs a setup.sh re-run to apply');
  }

  // The core of the 3+-site fix: the promoted node must inherit the old
  // master's registry and re-point the sibling spoke at itself. Before the
  // fix, spoke2 kept following the demoted master forever and the new master
  // did not know spoke2 existed.
  step('Verifying the promotion inherited the old master\'s registry and re-pointed the sibling');
  if (!promoteRes.body.siblings) {
    fail('expected /site-promote to report what happened to the other spokes (siblings)');
  } else {
    const sib = promoteRes.body.siblings;
    if (sib.adopted < 1) fail(`expected the promotion to adopt the sibling spoke, got ${JSON.stringify(sib)}`);
    if (sib.repointed < 1) fail(`expected the promotion to re-point the sibling spoke, got ${JSON.stringify(sib)}`);
    if (sib.orphaned !== 0) fail(`expected no orphaned siblings after promotion, got ${JSON.stringify(sib)}`);
  }

  step('Verifying spoke2 now follows the NEW master, not the demoted one');
  let repointed = false;
  for (let i = 0; i < 20; i++) {
    const { body } = await api(SPOKE2_URL, '/api/site/config', { token: spoke2Token });
    if (body.config && body.config.masterUrl === 'http://spoke:3001') { repointed = true; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!repointed) {
    const { body } = await api(SPOKE2_URL, '/api/site/config', { token: spoke2Token });
    fail(`spoke2 should follow the newly-promoted master after the handoff, got masterUrl=${JSON.stringify(body.config && body.config.masterUrl)}`);
  }

  step('Verifying the new master knows about BOTH the demoted master and spoke2');
  const { body: newMasterStatus } = await api(SPOKE_URL, '/api/directory-admin/site-status', { token: spokeToken });
  const endpoints = (newMasterStatus.spokes || []).map((s) => s.endpoint).sort();
  if (!endpoints.includes('http://master:3001') || !endpoints.includes('http://spoke2:3001')) {
    fail(`new master should have both siblings registered, got ${JSON.stringify(endpoints)}`);
  }
  const serverIds = (newMasterStatus.spokes || []).map((s) => s.ldapServerId).filter(Boolean);
  if (new Set(serverIds).size !== serverIds.length) {
    fail(`inherited spokes must not share an LDAP ServerID, got ${JSON.stringify(serverIds)}`);
  }
  if (serverIds.includes(1)) {
    fail(`no spoke may hold ServerID 1 -- that is the new master's, got ${JSON.stringify(serverIds)}`);
  }

  step('Verifying the demoted old master auto-registered itself as a real spoke of the new master (not orphaned)');
  // The demoted old master re-registers asynchronously after promotion, so
  // poll until it appears as a peer. The new master is site 1 (10.1.0.2 is its
  // OWN address, never a peer); the demoted old master is assigned a fresh
  // ServerID, so it appears at its own mesh address -- the point is that it IS
  // a registered peer with a valid id, not that it keeps its old one.
  let oldMasterAsPeer = null;
  for (let i = 0; i < 20; i++) {
    const { body: newMasterLdapCfg } = await api(SPOKE_URL, '/api/directory-admin/ldap-replication-config', { token: spokeToken });
    oldMasterAsPeer = (newMasterLdapCfg.peers || []).find(p => p.ldapServerId !== 1 && typeof p.ldapServerId === 'number');
    if (oldMasterAsPeer) break;
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!oldMasterAsPeer) {
    const { body: newMasterLdapCfg } = await api(SPOKE_URL, '/api/directory-admin/ldap-replication-config', { token: spokeToken });
    fail(`the demoted old master should appear as a registered peer with an assigned ldapServerId, got ${JSON.stringify(newMasterLdapCfg.peers)}`);
  }

  step('Verifying the newly-promoted node is master');
  const { body: newMasterCfg } = await api(SPOKE_URL, '/api/site/config', { token: spokeToken });
  if (newMasterCfg.config.isMaster !== true) fail(`newly-promoted node should be isMaster:true, got ${JSON.stringify(newMasterCfg.config)}`);

  step('Verifying the old master was actually demoted to a spoke of the new master');
  const { body: oldMasterCfg } = await api(MASTER_URL, '/api/site/config', { token: masterToken });
  if (oldMasterCfg.config.isMaster !== false) fail(`old master should be isMaster:false after being demoted, got ${JSON.stringify(oldMasterCfg.config)}`);
  if (oldMasterCfg.config.masterUrl !== 'http://spoke:3001') {
    fail(`old master's masterUrl should now point at the new master, got ${JSON.stringify(oldMasterCfg.config.masterUrl)}`);
  }

  // Same correction as the post-join write above: a demoted node is a spoke,
  // and a spoke forwards rather than refuses. What must be true is that its
  // write goes UPSTREAM to the node that is now master, not into its own
  // catalog -- which is exactly what a promotion has to guarantee.
  step('Verifying a write on the demoted old master is forwarded to the NEW master');
  const oldMasterWrite = await api(MASTER_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: masterToken,
    body: { name: 'E2E Post-Demotion Host', slug: 'host_e2e_post_demotion', kind: 'host', parentSlug: 'site_e2e' }
  });
  if (oldMasterWrite.status !== 200) {
    fail(`expected the demoted node to forward its write to the new master, got ${oldMasterWrite.status} ${JSON.stringify(oldMasterWrite.body)}`);
  }
  {
    const onNewMaster = await api(SPOKE_URL, '/api/directory-admin/resources', { token: spokeToken });
    const slugs = (onNewMaster.body.results || onNewMaster.body.resources || onNewMaster.body || []).map((x) => x.slug);
    if (!slugs.includes('host_e2e_post_demotion')) {
      fail(`the demoted node's write did not reach the new master. new-master slugs=${JSON.stringify(slugs)}`);
    }
  }

  const newMasterWrite = await api(SPOKE_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: spokeToken,
    body: { name: 'E2E Post-Promotion Host', slug: 'host_e2e_postpromotion', kind: 'host', parentSlug: 'site_e2e' }
  });
  if (newMasterWrite.status !== 200) fail(`expected the newly-promoted master to accept writes, got ${newMasterWrite.status} ${JSON.stringify(newMasterWrite.body)}`);

  // The real proof the handoff worked: a write on the NEW master has to reach
  // the sibling that was never told about the promotion by hand.
  step('Verifying a post-promotion write on the new master replicates to spoke2');
  let siblingReplicated = false;
  for (let i = 0; i < 30; i++) {
    const r = await api(SPOKE2_URL, '/api/directory-admin/resources', { token: spoke2Token });
    const slugs = (r.body.results || r.body.resources || r.body || []).map((x) => x.slug);
    if (slugs.includes('host_e2e_postpromotion')) { siblingReplicated = true; break; }
    await new Promise((res) => setTimeout(res, 500));
  }
  if (!siblingReplicated) {
    fail('a write on the newly-promoted master never reached spoke2 -- the sibling is still orphaned');
  }

  if (failed) {
    console.error('MULTISITE E2E: one or more checks failed (see above)');
    process.exit(1);
  }
  console.log('MULTISITE E2E PASS');
}

main().catch((e) => {
  console.error('MULTISITE E2E FAIL (exception):', e.stack || e.message);
  process.exit(1);
});
