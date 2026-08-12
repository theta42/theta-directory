'use strict';

// WireGuard keypair generation using Node's built-in crypto.
//
// A WireGuard key IS an X25519 key in raw base64 -- no `wg genkey` binary
// needed, which matters here because the directory container has no
// wireguard-tools installed and should not need them just to hand a phone a
// config.
//
// Deliberately identical to jump-host's utils/wg_keys.js. Both sides generate
// keys for the same mesh, and this is 20 lines of well-defined format work;
// sharing it would mean a new published package on the critical path of two
// repos for no behavioural gain.

const crypto = require('crypto');

/**
 * @returns {{ privateKey: string, publicKey: string }} raw X25519, base64
 */
function generateKeypair() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519', {
		publicKeyEncoding: { type: 'spki', format: 'der' },
		privateKeyEncoding: { type: 'pkcs8', format: 'der' },
	});

	// DER PKCS#8 private key: the raw 32-byte scalar starts at offset 16.
	// DER SPKI public key: the raw 32-byte point starts at offset 12.
	return {
		privateKey: privateKey.slice(16, 48).toString('base64'),
		publicKey: publicKey.slice(12, 44).toString('base64'),
	};
}

module.exports = { generateKeypair };
