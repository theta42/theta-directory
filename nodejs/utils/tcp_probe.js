'use strict';

// "Is anything listening there right now?" -- a TCP connect and nothing more.
//
// This exists because a timeout is not a reachability test. A request to an
// address with no route takes the FULL request timeout to fail, and that
// timeout has to be generous enough for the work the request does at the far
// end. Those two requirements are in direct conflict for any call that prefers
// one address and falls back to another: the fallback cannot start until the
// generous timeout on the unreachable address has expired.
//
// Separating them lets each be sized for its own job -- a connect either
// succeeds in milliseconds on a LAN or tunnel, or is not going to succeed at
// all, while the request that follows can take as long as the far end needs.

const net = require('net');

const DEFAULT_PROBE_TIMEOUT_MS = 1000;

function tcpReachable(host, port, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
	return new Promise((resolve) => {
		let settled = false;
		const finish = (reachable) => {
			if (settled) return;
			settled = true;
			// destroy(), not end(): we want the socket gone now, not a polite
			// FIN handshake with a peer that may never answer.
			try { socket.destroy(); } catch (e) {}
			resolve(reachable);
		};

		let socket;
		try {
			socket = net.connect({ host, port });
		} catch (err) {
			// A malformed host never reaches the event handlers below.
			return resolve(false);
		}
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => finish(true));
		socket.once('timeout', () => finish(false));
		socket.once('error', () => finish(false));
	});
}

module.exports = { tcpReachable, DEFAULT_PROBE_TIMEOUT_MS };
