'use strict';

// The Ed25519 key pair the SSO signs high-risk agent commands with, stored in
// OpenBao at `secret/agent/signing-key`.
//
// This used to be generated in the AgentManager constructor and kept only in
// memory, which made the whole signing scheme decorative: every SSO restart
// produced a new key, so the `public_key` pinned in an agent's agent.yml stopped
// matching and the agent either rejected everything or (because it skips
// verification when no key is configured) executed everything unverified. A
// trust anchor that changes on restart is not a trust anchor.
//
// Requires the sso-broker OpenBao policy to grant `secret/agent/*`
// (theta-suite setup.sh). Without it the load fails and signing is reported as
// unavailable -- we deliberately do NOT fall back to an ephemeral key, because
// signing with a key no agent has ever seen is worse than refusing: it looks
// like it worked.

const crypto = require('crypto');
const baoConf = require('@simpleworkjs/bao-conf');

const PATH = 'agent/signing-key'; // baoConf adds the secret/data prefix

let cached = null;      // { privateKeyPem, publicKeyPem, publicKeyBase64 }
let loadError = null;

// Agents pin the raw 32-byte Ed25519 public key, base64-encoded (see the Go
// client's verifySignature, which base64-decodes cfg.public_key and expects
// ed25519.PublicKeySize bytes). Node hands us SPKI PEM, so strip the 12-byte
// DER prefix to get the raw key the agent actually wants.
function rawPublicKeyBase64(publicKeyPem) {
	const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
	return Buffer.from(der.subarray(der.length - 32)).toString('base64');
}

function generate() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' }
	});
	return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

// Load the stored key pair, generating and persisting one on first run.
// Idempotent and safe to call repeatedly; the result is cached in-process.
async function load() {
	if (cached) return cached;

	let stored = null;
	try {
		stored = await baoConf.get(PATH);
	} catch (err) {
		loadError = `could not read ${PATH} from OpenBao: ${err.message}`;
		console.error(`[agent_keys] ${loadError}`);
		return null;
	}

	if (stored && stored.privateKeyPem && stored.publicKeyPem) {
		cached = {
			privateKeyPem: stored.privateKeyPem,
			publicKeyPem: stored.publicKeyPem,
			publicKeyBase64: rawPublicKeyBase64(stored.publicKeyPem)
		};
		loadError = null;
		return cached;
	}

	// First run: mint one and persist it before use, so a crash between
	// generating and storing can't leave agents pinned to a key we forgot.
	const fresh = generate();
	try {
		await baoConf.set(PATH, fresh);
	} catch (err) {
		loadError = `could not persist a signing key to ${PATH}: ${err.message}. `
			+ 'Re-run ./setup.sh so the sso-broker policy grants secret/agent/*.';
		console.error(`[agent_keys] ${loadError}`);
		return null;
	}

	cached = {
		...fresh,
		publicKeyBase64: rawPublicKeyBase64(fresh.publicKeyPem)
	};
	loadError = null;
	console.log('[agent_keys] generated and stored a new agent signing key');
	return cached;
}

function status() {
	return { available: !!cached, error: loadError };
}

// Test seam: drop the in-process cache.
function _reset() {
	cached = null;
	loadError = null;
}

module.exports = { load, status, rawPublicKeyBase64, _reset, PATH };
