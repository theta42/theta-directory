'use strict';

// Exercises the relay against a REAL TCP listener standing in for slapd, so
// the socket lifecycle (connect, idle timeout, ceiling, per-ws cleanup) is
// tested through node's actual net stack rather than a mock of it.

const net = require('net');

let server;
let serverPort;
const serverSockets = [];

// A fake ws: records what the relay sends back and exposes readyState.
function makeWs() {
	return {
		readyState: 1,
		sent: [],
		send(raw) { this.sent.push(JSON.parse(raw)); },
		payloads() { return this.sent.map(m => m.payload); }
	};
}

const b64 = (s) => Buffer.from(s).toString('base64');
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// conf.ldap.url is read at require time, so each load re-mocks it at the
// freshly-bound test port.
function loadTunnel() {
	jest.resetModules();
	jest.doMock('@simpleworkjs/conf', () => ({ ldap: { url: `ldap://127.0.0.1:${serverPort}` } }));
	return require('../utils/ldap_tunnel');
}

// The live relay sockets this process holds against the stand-in slapd.
function relaySockets() {
	return process._getActiveHandles().filter(h => h instanceof net.Socket && h.remotePort === serverPort);
}

beforeAll(async () => {
	await new Promise((resolve) => {
		server = net.createServer((sock) => {
			serverSockets.push(sock);
			sock.on('data', (chunk) => sock.write(Buffer.concat([Buffer.from('re:'), chunk])));
			sock.on('error', () => {});
		});
		server.listen(0, '127.0.0.1', () => {
			serverPort = server.address().port;
			resolve();
		});
	});
});

afterAll(async () => {
	for (const s of serverSockets) s.destroy();
	await new Promise((resolve) => server.close(resolve));
});

test('relays bytes to the LDAP target and pipes the response back', async () => {
	const tunnel = loadTunnel();
	const ws = makeWs();

	tunnel.handleTunnel('agent-1', ws, { conn_id: 'c1', data: b64('hello') });
	await wait(200);

	const data = ws.payloads().find(p => p.data);
	expect(data).toBeTruthy();
	expect(Buffer.from(data.data, 'base64').toString()).toBe('re:hello');
	expect(tunnel.connectionCount('agent-1')).toBe(1);

	tunnel.cleanup('agent-1', ws);
	expect(tunnel.connectionCount('agent-1')).toBe(0);
});

test('an explicit close from the agent drops the relay socket', async () => {
	const tunnel = loadTunnel();
	const ws = makeWs();

	tunnel.handleTunnel('agent-2', ws, { conn_id: 'c1', data: b64('x') });
	await wait(200);
	expect(tunnel.connectionCount('agent-2')).toBe(1);

	tunnel.handleTunnel('agent-2', ws, { conn_id: 'c1', close: true });
	expect(tunnel.connectionCount('agent-2')).toBe(0);
});

// The leak these bounds exist for: an agent that never sends `close` and never
// disconnects cleanly used to strand its relay socket forever. The deadline is
// shortened on the live socket rather than waiting out the real five minutes —
// it drives the same 'timeout' handler the real deadline would.
test('an idle relay socket is torn down and the agent is told why', async () => {
	const tunnel = loadTunnel();
	const ws = makeWs();

	tunnel.handleTunnel('agent-3', ws, { conn_id: 'c1', data: b64('x') });
	await wait(200);
	expect(tunnel.connectionCount('agent-3')).toBe(1);
	expect(ws.payloads().filter(p => p.close).length).toBe(0);

	const live = relaySockets();
	expect(live.length).toBeGreaterThan(0);
	for (const h of live) h.setTimeout(60);
	await wait(500);

	const closes = ws.payloads().filter(p => p.close);
	expect(closes.length).toBeGreaterThan(0);
	expect(closes.some(c => (c.reason || '').includes('timeout'))).toBe(true);
	expect(tunnel.connectionCount('agent-3')).toBe(0);
});

test('a single agent cannot exceed the per-agent connection ceiling', async () => {
	const tunnel = loadTunnel();
	const ws = makeWs();
	const max = tunnel.MAX_CONNS_PER_AGENT;

	for (let i = 0; i < max; i++) {
		tunnel.handleTunnel('agent-5', ws, { conn_id: `c${i}`, data: b64('x') });
	}
	await wait(400);
	expect(tunnel.connectionCount('agent-5')).toBe(max);

	tunnel.handleTunnel('agent-5', ws, { conn_id: 'one-too-many', data: b64('x') });
	expect(tunnel.connectionCount('agent-5')).toBe(max);

	const refusal = ws.payloads().find(p => p.conn_id === 'one-too-many' && p.close);
	expect(refusal).toBeTruthy();
	expect(refusal.reason).toMatch(/ceiling/);

	tunnel.cleanup('agent-5', ws);
	expect(tunnel.connectionCount('agent-5')).toBe(0);
});

// Reconnect: the old ws closing must not take the new ws's relays with it.
test('cleanup is scoped to one ws, so a reconnect keeps its sockets', async () => {
	const tunnel = loadTunnel();
	const oldWs = makeWs();
	const newWs = makeWs();

	tunnel.handleTunnel('agent-6', oldWs, { conn_id: 'c1', data: b64('x') });
	tunnel.handleTunnel('agent-6', newWs, { conn_id: 'c1', data: b64('x') });
	await wait(250);
	expect(tunnel.connectionCount('agent-6')).toBe(2);

	tunnel.cleanup('agent-6', oldWs);
	expect(tunnel.connectionCount('agent-6')).toBe(1);

	tunnel.cleanup('agent-6', newWs);
	expect(tunnel.connectionCount('agent-6')).toBe(0);
});

test('cleanup without a ws drops every connection the agent holds', async () => {
	const tunnel = loadTunnel();
	const wsA = makeWs();
	const wsB = makeWs();

	tunnel.handleTunnel('agent-7', wsA, { conn_id: 'c1', data: b64('x') });
	tunnel.handleTunnel('agent-7', wsB, { conn_id: 'c1', data: b64('x') });
	await wait(250);
	expect(tunnel.connectionCount('agent-7')).toBe(2);

	tunnel.cleanup('agent-7');
	expect(tunnel.connectionCount('agent-7')).toBe(0);
});
