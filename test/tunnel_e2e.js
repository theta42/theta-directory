'use strict';

// End-to-end test of the LDAP byte-pump tunnel (DESIGN.md §4).
//
// Simulates the agent: enrolls one, connects to the SSO WSS with its token,
// sends a real LDAP bind request as raw bytes in an `ldap_tunnel` message, and
// verifies the SSO relays it into OpenLDAP and pipes the bind response back.
// This proves the SSO side of the tunnel without needing the agent binary.

const WebSocket = require('ws');

const SSO_URL = process.env.SSO_URL || 'http://sso:3001';
const WS_URL = SSO_URL.replace(/^http/, 'ws') + '/api/agent/ws';
const TEST_CREDS = { uid: 'test', password: 'MyTestPassword!2' };
const USER_DN = 'cn=test,ou=people,dc=test,dc=local';

function fail(msg) { console.error('E2E FAIL:', msg); process.exit(1); }

async function waitForSso() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${SSO_URL}/health`);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((res) => setTimeout(res, 1000));
  }
  fail('SSO never became ready');
}

async function login() {
  const r = await fetch(`${SSO_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_CREDS),
  });
  if (!r.ok) fail(`login failed: ${r.status}`);
  const body = await r.json();
  return body.token;
}

async function enrollAgent(authToken) {
  const r = await fetch(`${SSO_URL}/api/agent/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'auth-token': authToken },
    body: JSON.stringify({ name: `e2e-${Date.now().toString(36)}` }),
  });
  if (!r.ok) fail(`enroll failed: ${r.status}`);
  const body = await r.json();
  return body.token;
}

// Build a simple LDAP bind request (version 3) as raw BER bytes.
function buildBindRequest(dn, password) {
  const dnBuf = Buffer.from(dn, 'utf8');
  const pwBuf = Buffer.from(password, 'utf8');
  const version = Buffer.from([0x02, 0x01, 0x03]);
  const name = Buffer.concat([Buffer.from([0x04, dnBuf.length]), dnBuf]);
  const simple = Buffer.concat([Buffer.from([0x80, pwBuf.length]), pwBuf]);
  const bindContent = Buffer.concat([version, name, simple]);
  const bindReq = Buffer.concat([Buffer.from([0x60, bindContent.length]), bindContent]);
  const msgId = Buffer.from([0x02, 0x01, 0x01]);
  const msgContent = Buffer.concat([msgId, bindReq]);
  return Buffer.concat([Buffer.from([0x30, msgContent.length]), msgContent]);
}

// A successful bind response is a BindResponse (0x61) with resultCode 0 (0x0a 01 00).
function isSuccessBindResponse(buf) {
  return buf.includes(Buffer.from([0x61])) && buf.includes(Buffer.from([0x0a, 0x01, 0x00]));
}

async function main() {
  await waitForSso();
  const authToken = await login();
  const agentToken = await enrollAgent(authToken);
  console.log('E2E: enrolled agent, connecting WSS...');

  const ws = new WebSocket(`${WS_URL}?token=${agentToken}`);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  console.log('E2E: WSS connected');

  const bindBytes = buildBindRequest(USER_DN, TEST_CREDS.password);
  ws.send(JSON.stringify({
    type: 'ldap_tunnel',
    payload: { conn_id: 'e2e-1', data: bindBytes.toString('base64') },
  }));
  console.log('E2E: sent bind request bytes');

  const result = await new Promise((res, rej) => {
    const timeout = setTimeout(() => rej(new Error('timed out waiting for bind response')), 10000);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data); } catch (_) { return; }
      if (msg.type !== 'ldap_tunnel') return;
      if (msg.payload.close) return;
      const buf = Buffer.from(msg.payload.data || '', 'base64');
      if (isSuccessBindResponse(buf)) {
        clearTimeout(timeout);
        res({ ok: true, bytes: buf.length });
      }
    });
    ws.on('error', (e) => { clearTimeout(timeout); rej(e); });
  });

  console.log(`E2E: got successful bind response (${result.bytes} bytes)`);
  ws.close();
  console.log('E2E PASS');
  process.exit(0);
}

main().catch((e) => fail(e.message));
