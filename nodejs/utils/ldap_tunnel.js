'use strict';

// LDAP byte-pump relay (DESIGN.md §4). The agent forwards raw LDAP bytes from a
// local socket (SSSD) over the WSS channel as `ldap_tunnel` messages; this
// module relays them into the SSO's real OpenLDAP and pipes the responses back.
// The SSO does not parse LDAP either — it is a transparent socket relay.
//
// Because it is transparent, nothing in this module can tell a finished LDAP
// conversation from an idle one: the only "this is over" signal is the agent
// sending `close`, or the TCP socket ending. An agent that goes away without
// either (network partition, killed process, flapping WAN) therefore used to
// strand its relay sockets open indefinitely, and nothing capped how many a
// single agent could open. The three bounds below exist for that: an idle
// timeout, a connect deadline, and a per-agent ceiling. All three are
// deliberately generous — they are leak protection, not rate limiting, and an
// LDAP conversation legitimately sits idle between SSSD's binds.

const net = require('net');
const conf = require('@simpleworkjs/conf').ldap;

// No traffic in either direction for this long -> the relay socket is
// abandoned. SSSD holds an idle connection open between lookups, so this has
// to be well above its keepalive; five minutes is far past any real bind.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
// TCP connect to the local slapd must complete promptly — it is a loopback/
// same-network hop. A connect that hangs (slapd wedged, DNS black hole) must
// not hold a slot in the per-agent ceiling forever.
const CONNECT_TIMEOUT_MS = 10 * 1000;
// Per-agent ceiling on simultaneous relay sockets. A real host runs one SSSD
// with a handful of connections; anything approaching this is a loop or a
// leak, and refusing is better than letting one agent exhaust the SSO's fd
// table for every other agent.
const MAX_CONNS_PER_AGENT = 64;

// Parse host:port from an ldap:// or ldaps:// URL. The relay connects plaintext
// to the SSO's own slapd (which is plaintext on localhost); an ldaps:// URL
// would need TLS termination here and is not supported yet (DESIGN.md §9.5).
function ldapTarget() {
	const url = conf.url || 'ldap://localhost:389';
	const m = /^ldaps?:\/\/([^:/]+)(?::(\d+))?/.exec(url);
	const host = m ? m[1] : 'localhost';
	const port = m && m[2] ? Number(m[2]) : 389;
	return { host, port };
}

// Relay state keyed by the WebSocket, not by agentId: ws -> Map(conn_id ->
// socket). An agent that reconnects (the common case on a flapping WAN) has
// two live ws objects for a moment, and the OLD one's close event fires after
// the new one is already relaying. Keyed by agentId, that close tore down the
// NEW connection's sockets too. The ws object is the real lifetime boundary
// here, so it is the key; agentId is carried alongside purely for log lines.
const relays = new Map();

function relayFor(agentId, ws) {
	let entry = relays.get(ws);
	if (!entry) {
		entry = { agentId, conns: new Map() };
		relays.set(ws, entry);
	}
	return entry.conns;
}

function sendToAgent(ws, payload) {
	if (ws && ws.readyState === 1) {
		try {
			ws.send(JSON.stringify({ type: 'ldap_tunnel', payload }));
		} catch (e) { /* peer vanished mid-send; the close handler cleans up */ }
	}
}

// Tear one relay socket down and tell the agent its end is gone, so the
// agent's local SSSD socket doesn't hang waiting for bytes that will never
// arrive. Idempotent.
function dropConn(conns, connId, sock, ws, reason) {
	if (conns.get(connId) === sock) conns.delete(connId);
	if (!sock.destroyed) sock.destroy();
	sendToAgent(ws, { conn_id: connId, close: true, ...(reason ? { reason } : {}) });
}

// Handle one ldap_tunnel message from an agent.
function handleTunnel(agentId, ws, payload) {
	const connId = payload.conn_id;
	if (!connId) return;
	const conns = relayFor(agentId, ws);

	// End of connection: close the relay socket.
	if (payload.close) {
		const sock = conns.get(connId);
		if (sock) { sock.destroy(); conns.delete(connId); }
		if (conns.size === 0) relays.delete(ws);
		return;
	}

	const data = Buffer.from(payload.data || '', 'base64');
	if (data.length === 0) return;

	let sock = conns.get(connId);
	if (!sock) {
		if (conns.size >= MAX_CONNS_PER_AGENT) {
			console.error(`[ldap-tunnel] agent ${agentId} is at the ${MAX_CONNS_PER_AGENT}-connection ceiling; refusing conn ${connId}`);
			sendToAgent(ws, { conn_id: connId, close: true, reason: 'connection ceiling reached' });
			return;
		}

		const { host, port } = ldapTarget();
		sock = net.connect(port, host);
		conns.set(connId, sock);

		// Two distinct deadlines on the same socket. Until 'connect' fires,
		// setTimeout() governs how long the CONNECT may take; after it fires,
		// it is rearmed as the idle timeout. net.Socket.setTimeout does not
		// destroy the socket on its own — the handler must.
		sock.setTimeout(CONNECT_TIMEOUT_MS);
		sock.once('connect', () => { sock.setTimeout(IDLE_TIMEOUT_MS); });
		sock.on('timeout', () => {
			const phase = sock.connecting ? 'connect' : 'idle';
			console.error(`[ldap-tunnel] agent ${agentId} conn ${connId} hit the ${phase} timeout; dropping`);
			dropConn(conns, connId, sock, ws, `${phase} timeout`);
		});

		// Relay OpenLDAP's responses back to the agent.
		sock.on('data', (chunk) => {
			sendToAgent(ws, { conn_id: connId, data: chunk.toString('base64') });
		});
		sock.on('close', () => {
			if (conns.get(connId) === sock) conns.delete(connId);
			const entry = relays.get(ws);
			if (entry && entry.conns === conns && conns.size === 0) relays.delete(ws);
			sendToAgent(ws, { conn_id: connId, close: true });
		});
		sock.on('error', () => { sock.destroy(); });
	}
	sock.write(data);
}

// Drop every relay socket for one WSS connection (on disconnect). Pass the ws
// that closed; without it this falls back to dropping every connection the
// agent holds, which is only correct for a hard deregistration.
function cleanup(agentId, ws) {
	if (ws) {
		const entry = relays.get(ws);
		if (entry) {
			for (const sock of entry.conns.values()) sock.destroy();
			relays.delete(ws);
		}
		return;
	}
	for (const [key, entry] of [...relays]) {
		if (entry.agentId !== agentId) continue;
		for (const sock of entry.conns.values()) sock.destroy();
		relays.delete(key);
	}
}

// Test/observability seam: how many relay sockets an agent currently holds
// across all of its live WSS connections.
function connectionCount(agentId) {
	let n = 0;
	for (const entry of relays.values()) {
		if (entry.agentId === agentId) n += entry.conns.size;
	}
	return n;
}

module.exports = {
	handleTunnel, cleanup, connectionCount,
	IDLE_TIMEOUT_MS, CONNECT_TIMEOUT_MS, MAX_CONNS_PER_AGENT
};
