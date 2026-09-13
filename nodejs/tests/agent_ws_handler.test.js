'use strict';

// The agent WebSocket handler (routes/api_agent.initAgentWebSockets).
//
// Nothing covered this before -- authentication, join-key enrollment, the config
// frame and the whole message switch -- which is how two fatal regressions
// shipped and stayed invisible:
//
//   1. the config frame was assembled with a ReferenceError in the middle of
//      it, so no agent ever received one: a join-key host never learned its own
//      token, re-dialled with the join key, collided with its own hostname and
//      was locked out 4001 for good;
//   2. the agent answers commands with a bare {status, message} and no
//      envelope, and every one of those frames was dropped here in silence.
//
// The fake socket is deliberately thin: an EventEmitter that records what was
// written. That is the whole contract this handler has with `ws`.

const EventEmitter = require('events');

jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
  request: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
}), { virtual: true });

// api_agent.js DESTRUCTURES these at require time, so a spy on the module object
// would never be seen -- the module has to be replaced before it is required.
// Which site a joining host is filed under is agent_site.js's business and has
// its own tests; here it just has to resolve.
jest.mock('../utils/agent_site', () => ({
  currentSite: jest.fn(async () => global.__wsTestSite),
  resolveSiteHint: jest.fn(async () => global.__wsTestSite),
  resolveAgentSite: jest.fn(async () => global.__wsTestSite)
}));

// A stable signing key, so the config frame has a public key to hand over
// without OpenBao being reachable from a unit test.
jest.mock('../utils/agent_keys', () => ({
  // Only publicKeyBase64 is read on the paths these tests drive (it is what the
  // config frame hands a joining agent). The PEM pair is not spelled out: a
  // literal key block in a fixture is indistinguishable from a leaked one to
  // every secret scanner that reads this repo, and signing is not exercised
  // here. utils/agent_manager's own tests cover that with a real generated key.
  load: jest.fn(async () => ({
    publicKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    publicKeyPem: null,
    privateKeyPem: null
  })),
  status: jest.fn(() => ({ available: true, error: null }))
}));

const crypto = require('crypto');
const { initORM } = require('../models');
const { Resource } = require('../models/resource');
const { Agent, AgentJoinKey } = require('../models/agent');
const agentManager = require('../utils/agent_manager');
const siteReplicate = require('../utils/site_replicate');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
    this.sent = [];
    this.closed = null;
    this.terminated = false;
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; }
  terminate() { this.terminated = true; this.readyState = 3; }
  ping() { this.pinged = (this.pinged || 0) + 1; }
  framesOfType(type) { return this.sent.filter(m => m.type === type); }
}

const connect = async (wss, { token, hostname, prevToken, query = {} } = {}) => {
  const ws = new FakeSocket();
  const params = new URLSearchParams(query);
  if (hostname) params.set('hostname', hostname);
  const headers = { host: 'sso.test' };
  if (token) headers.authorization = token;
  if (prevToken) headers['x-theta-prev-token'] = prevToken;
  const req = {
    url: `/api/agent/ws?${params.toString()}`,
    headers,
    socket: { remoteAddress: '10.9.9.9' }
  };
  wss.emit('connection', ws, req);
  // The handler authenticates and answers from async paths, so wait for the
  // OUTCOME rather than for a fixed number of milliseconds: either a frame went
  // out or the socket was closed. A sleep long enough today is a flaky test
  // tomorrow, the moment anything on the connect path does slightly more work.
  await waitFor(() => ws.sent.length > 0 || ws.closed);
  return ws;
};

// Poll until `cond` holds or the deadline passes. Returns either way -- the
// assertion that follows is what should report the failure, with its own
// message, rather than this throwing something less informative.
const waitFor = async (cond, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise(r => setTimeout(r, 10));
  }
  return false;
};

describe('agent WebSocket handler', () => {
  let app;
  let replicateSpy;
  let site;
  const RUN = crypto.randomBytes(3).toString('hex');
  const hostname = (label) => `ws-${label}-${RUN}`;
  const created = [];

  const enroll = async (label) => {
    const { agent, token } = await Agent.enroll({ name: hostname(label), enrolledBy: 'admin' });
    created.push(agent.id);
    return { agent, token };
  };

  beforeAll(async () => {
    await initORM();
    site = await Resource.create({
      id: crypto.randomUUID(),
      kind: 'site',
      name: `ws-test-site-${RUN}`,
      slug: `site_ws-test-${RUN}`,
      metadata: {},
      created_on: Math.floor(Date.now() / 1000)
    });
    global.__wsTestSite = { id: site.id, name: site.name, slug: site.slug };
    app = { wss: new EventEmitter(), io: null };
    require('../routes/api_agent').initAgentWebSockets(app);
  });

  afterAll(async () => {
    for (const id of created) {
      const row = await Agent.get(id).catch(() => null);
      if (row) await row.delete().catch(() => {});
    }
    // Anything the join-key path enrolled under this run's names.
    const rows = await Agent.list().catch(() => []);
    for (const row of rows) {
      if (String(row.name || '').endsWith(`-${RUN}`)) await row.delete().catch(() => {});
    }
    await site.delete().catch(() => {});
    delete global.__wsTestSite;
  });

  beforeEach(() => {
    replicateSpy = jest.spyOn(siteReplicate, 'replicateToSpokes').mockImplementation(() => {});
  });

  afterEach(() => {
    replicateSpy.mockRestore();
  });

  test('an unknown credential is closed 4001 and told nothing else', async () => {
    const ws = await connect(app.wss, { token: 'not-a-token-we-issued' });
    expect(ws.closed).toEqual({ code: 4001, reason: 'Unauthorized' });
    expect(ws.sent).toHaveLength(0);
  });

  test('an enrolled agent receives a config frame', async () => {
    const { agent, token } = await enroll('cfg');
    const ws = await connect(app.wss, { token, hostname: hostname('cfg') });

    expect(ws.closed).toBeNull();
    const config = ws.framesOfType('config');
    expect(config).toHaveLength(1);
    expect(config[0].payload.agent_id).toBe(agent.id);
    expect(config[0].payload.protocol_version).toBe('1.3.0');
    // Not an enrollment, so no credentials ride along.
    expect(config[0].payload.auth_token).toBeUndefined();

    agentManager.disconnect(agent.id);
  });

  test('a join key enrolls the host AND hands it the credentials it must persist', async () => {
    const { raw } = await AgentJoinKey.issue({ label: 'ws-test', createdBy: 'admin' });
    const ws = await connect(app.wss, { token: raw, hostname: hostname('join') });

    expect(ws.closed).toBeNull();
    const config = ws.framesOfType('config');
    expect(config).toHaveLength(1);
    // THE regression: without these the host never persists a token, re-dials
    // with the join key, collides on its own name and is rejected for good.
    expect(config[0].payload.enrolled).toBe(true);
    expect(typeof config[0].payload.auth_token).toBe('string');
    expect(config[0].payload.auth_token.length).toBeGreaterThan(10);
    expect(config[0].payload.public_key).toBe('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');

    const enrolled = (await Agent.list({ where: { name: hostname('join') } }))[0];
    expect(enrolled).toBeDefined();
    agentManager.disconnect(enrolled.id);
  });

  test('a join key cannot take over a hostname it cannot prove it owns', async () => {
    const { agent, token } = await enroll('owned');
    const { raw } = await AgentJoinKey.issue({ label: 'ws-test', createdBy: 'admin' });

    const thief = await connect(app.wss, { token: raw, hostname: hostname('owned') });
    expect(thief.closed.code).toBe(4001);
    expect(thief.sent).toHaveLength(0);
    // The real host's token still works.
    expect(await Agent.authenticate(token)).toBeTruthy();

    // The host itself, presenting the token it held before its enrollment was
    // cleared, is rotated onto a fresh one (contract G-2).
    const rejoin = await connect(app.wss, { token: raw, hostname: hostname('owned'), prevToken: token });
    expect(rejoin.closed).toBeNull();
    const config = rejoin.framesOfType('config');
    expect(config[0].payload.enrolled).toBe(true);
    expect(config[0].payload.auth_token).not.toBe(token);
    // ... and the old one is dead.
    expect(await Agent.authenticate(token)).toBeNull();

    agentManager.disconnect(agent.id);
  });

  test('a bare {status} frame from an older agent is recorded as its response', async () => {
    const { agent, token } = await enroll('resp');
    const ws = await connect(app.wss, { token, hostname: hostname('resp') });

    // Exactly what the agent wrote up to v2.21.9: no envelope at all.
    ws.emit('message', JSON.stringify({ status: 'ok', message: 'done', output: 'uptime: 3 days' }));
    await waitFor(() => agentManager.liveState(agent.id).lastResponse !== null);

    const live = agentManager.liveState(agent.id);
    expect(live.lastResponse).not.toBeNull();
    expect(live.lastResponse.status).toBe('ok');
    expect(live.lastResponse.output).toBe('uptime: 3 days');

    agentManager.disconnect(agent.id);
  });

  test('a properly enveloped response is recorded too', async () => {
    const { agent, token } = await enroll('resp2');
    const ws = await connect(app.wss, { token, hostname: hostname('resp2') });

    ws.emit('message', JSON.stringify({
      type: 'response',
      payload: { status: 'error', message: 'storage capability disabled' }
    }));
    await waitFor(() => agentManager.liveState(agent.id).lastResponse !== null);

    const live = agentManager.liveState(agent.id);
    expect(live.lastResponse.status).toBe('error');
    expect(live.lastResponse.message).toBe('storage capability disabled');

    agentManager.disconnect(agent.id);
  });

  test('a revoked enrollment is dropped on the next thing the agent says', async () => {
    const { agent, token } = await enroll('revoked');
    const ws = await connect(app.wss, { token, hostname: hostname('revoked') });
    expect(ws.closed).toBeNull();

    await agent.update({ revoked: true });
    ws.emit('message', JSON.stringify({ type: 'heartbeat', payload: {} }));
    await waitFor(() => ws.closed !== null);

    expect(ws.closed).toEqual({ code: 4003, reason: 'Enrollment revoked' });

    agentManager.disconnect(agent.id);
  });
});
