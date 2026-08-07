'use strict';

// LDAP byte-pump relay (DESIGN.md §4). The agent forwards raw LDAP bytes from a
// local socket (SSSD) over the WSS channel as `ldap_tunnel` messages; this
// module relays them into the SSO's real OpenLDAP and pipes the responses back.
// The SSO does not parse LDAP either — it is a transparent socket relay.

const net = require('net');
const conf = require('@simpleworkjs/conf').ldap;

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

// Per-agent relay state: agentId -> Map(conn_id -> LDAP socket).
const relays = new Map();

function relayFor(agentId) {
	if (!relays.has(agentId)) relays.set(agentId, new Map());
	return relays.get(agentId);
}

// Handle one ldap_tunnel message from an agent.
function handleTunnel(agentId, ws, payload) {
	const connId = payload.conn_id;
	if (!connId) return;
	const conns = relayFor(agentId);

	// End of connection: close the relay socket.
	if (payload.close) {
		const sock = conns.get(connId);
		if (sock) { sock.destroy(); conns.delete(connId); }
		return;
	}

	const data = Buffer.from(payload.data || '', 'base64');
	if (data.length === 0) return;

	let sock = conns.get(connId);
	if (!sock) {
		const { host, port } = ldapTarget();
		sock = net.connect(port, host);
		conns.set(connId, sock);

		// Relay OpenLDAP's responses back to the agent.
		sock.on('data', (chunk) => {
			if (ws.readyState === 1) {
				ws.send(JSON.stringify({
					type: 'ldap_tunnel',
					payload: { conn_id: connId, data: chunk.toString('base64') }
				}));
			}
		});
		sock.on('close', () => {
			conns.delete(connId);
			if (ws.readyState === 1) {
				ws.send(JSON.stringify({
					type: 'ldap_tunnel',
					payload: { conn_id: connId, close: true }
				}));
			}
		});
		sock.on('error', () => { sock.destroy(); });
	}
	sock.write(data);
}

// Drop every relay socket for an agent (on WSS disconnect).
function cleanup(agentId) {
	const conns = relays.get(agentId);
	if (conns) {
		for (const sock of conns.values()) sock.destroy();
		relays.delete(agentId);
	}
}

module.exports = { handleTunnel, cleanup };
