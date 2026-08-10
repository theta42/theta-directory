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

  for (const group of ['app_sso_admin']) {
    const modLdif = `dn: cn=${group},ou=groups,${baseDn}\nchangetype: modify\nadd: member\nmember: cn=${ADMIN_UID},ou=people,${baseDn}\n`;
    await execFileAsync('ldapmodify', ['-x', '-H', `ldap://${ldapHost}:389`, '-D', bindDn, '-w', LDAP_ADMIN_PASS], { input: modLdif })
      .catch((e) => { if (!/[Tt]ype or value exists/.test(e.stderr || '')) throw e; });
  }
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
  step('Waiting for master + spoke to be healthy');
  await waitForHealthy(MASTER_URL, 'master');
  await waitForHealthy(SPOKE_URL, 'spoke');

  step('Seeding admin users in both sites\' LDAP');
  await seedAdmin(MASTER_LDAP_HOST, MASTER_BASE_DN);
  await seedAdmin(SPOKE_LDAP_HOST, SPOKE_BASE_DN);

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

  step('Verifying spoke persisted isMaster:false + masterUrl after join');
  const { body: spokeCfg } = await api(SPOKE_URL, '/api/site/config', { token: spokeToken });
  if (spokeCfg.config.isMaster !== false) fail(`spoke should be isMaster:false after join, got ${JSON.stringify(spokeCfg.config)}`);
  if (!spokeCfg.config.masterUrl) fail('spoke should have masterUrl set after join');

  step('Verifying the spoke adopted the master\'s pre-join catalog');
  const spokeResources = await api(SPOKE_URL, '/api/directory-admin/resources', { token: spokeToken });
  const adopted = (spokeResources.body.results || spokeResources.body.resources || spokeResources.body || []);
  const found = Array.isArray(adopted) && adopted.some(r => r.slug === 'host_e2e_prejoin');
  if (!found) fail(`spoke did not adopt master's pre-join resource; got slugs=${JSON.stringify((adopted || []).map(r => r.slug))}`);

  step('Verifying spoke is now read-only (write attempt must 403)');
  const writeAttempt = await api(SPOKE_URL, '/api/directory-admin/resources', {
    method: 'POST',
    token: spokeToken,
    body: { name: 'Should Be Rejected', slug: 'host_e2e_should_reject', kind: 'host' }
  });
  if (writeAttempt.status !== 403) fail(`expected 403 writing to spoke post-join, got ${writeAttempt.status} ${JSON.stringify(writeAttempt.body)}`);

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

  step('Verifying WAN health ping from spoke to master succeeds');
  const statusRes = await api(SPOKE_URL, '/api/directory-admin/site-status', { token: spokeToken });
  if (statusRes.body.config && statusRes.body.config.wanConnected !== true) {
    fail(`expected spoke to report wanConnected:true post-join, got ${JSON.stringify(statusRes.body.config)}`);
  }

  step('Verifying master itself is unaffected (still isMaster:true, no writes blocked)');
  const { body: masterCfg } = await api(MASTER_URL, '/api/site/config', { token: masterToken });
  if (masterCfg.config.isMaster !== true) fail('master flipped away from isMaster:true unexpectedly');

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
