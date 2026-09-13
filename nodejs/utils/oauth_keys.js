'use strict';

// The RSA key pair ID tokens are signed with, stored in OpenBao at
// `secret/oauth/id-token-key`, and published as a JWKS at
// /.well-known/jwks.json.
//
// WHY THIS EXISTS
//
// ID tokens used to be signed HS256 with `conf.oauth.jwtSecret` — ONE secret,
// shared by every registered client. Two problems with that, and the second is
// the serious one:
//
//   1. No `jwks_uri` is possible, because there is no public half to publish.
//      A relying party has to be handed a shared secret out of band, which is
//      the step most OIDC libraries have no configuration for at all.
//   2. Every client validates with the same key it could sign with. Any client
//      holding it can mint an ID token for ANY OTHER client — including one
//      asserting a different `sub`. The OIDC spec's HS256 mode uses the
//      client's own `client_secret` as the MAC key precisely to keep clients
//      separated; a single global secret loses that.
//
// Per-client HS256 is not available to us: client secrets are stored bcrypt
// -hashed (models/oauth_client.js), so the raw value needed to compute a MAC is
// deliberately unrecoverable. RS256 is the fix that also removes the out-of-band
// step: clients fetch the public half from the JWKS and need no shared secret.
//
// FALLBACK. If the key cannot be loaded or persisted, signing falls back to the
// legacy HS256 secret rather than refusing. That is the opposite of the choice
// agent_keys.js makes, and deliberately: refusing to sign an agent command
// fails one command, refusing to sign an ID token fails every login on the
// deployment. The fallback is loud, and `status()` reports it.

const crypto = require('crypto');
const baoConf = require('@simpleworkjs/bao-conf');

const PATH = 'oauth/id-token-key'; // baoConf adds the secret/data prefix
const MODULUS_BITS = 2048;

let cached = null;      // { privateKeyPem, publicKeyPem, kid }
let loadError = null;

function generate() {
	const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
		modulusLength: MODULUS_BITS,
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' }
	});
	return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

// RFC 7638 JWK thumbprint: the kid is derived FROM the key, so it is stable
// across restarts and across sites that share the key, and two different keys
// can never collide on one. Generating a random kid would mean a restart
// invalidating every cached JWKS entry a relying party holds.
function thumbprint(jwk) {
	const canonical = JSON.stringify({ e: jwk.e, kty: jwk.kty, n: jwk.n });
	return crypto.createHash('sha256').update(canonical).digest('base64url');
}

function publicJwk(publicKeyPem) {
	const jwk = crypto.createPublicKey(publicKeyPem).export({ format: 'jwk' });
	return { kty: jwk.kty, n: jwk.n, e: jwk.e };
}

function decorate(material) {
	const jwk = publicJwk(material.publicKeyPem);
	return { ...material, kid: thumbprint(jwk) };
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
		console.error(`[oauth_keys] ${loadError} — ID tokens will fall back to legacy HS256`);
		return null;
	}

	if (stored && stored.privateKeyPem && stored.publicKeyPem) {
		cached = decorate(stored);
		loadError = null;
		return cached;
	}

	// First run: mint one and persist it before use, so a crash between
	// generating and storing cannot leave relying parties holding a JWKS for a
	// key we no longer have.
	const fresh = generate();
	try {
		await baoConf.set(PATH, fresh);
	} catch (err) {
		loadError = `could not persist an ID token key to ${PATH}: ${err.message}. `
			+ 'Re-run ./setup.sh so the sso-broker policy grants secret/oauth/*.';
		console.error(`[oauth_keys] ${loadError} — ID tokens will fall back to legacy HS256`);
		return null;
	}

	cached = decorate(fresh);
	loadError = null;
	console.log(`[oauth_keys] generated and stored a new RS256 ID token key (kid ${cached.kid})`);
	return cached;
}

// The public half, in the shape /.well-known/jwks.json serves. Returns an empty
// key set rather than throwing when no key is available: a relying party
// fetching an empty JWKS gets a clear "this provider publishes no RS256 keys",
// which is true, instead of a 500.
async function jwks() {
	const keys = await load();
	if (!keys) return { keys: [] };
	return {
		keys: [{
			...publicJwk(keys.publicKeyPem),
			use: 'sig',
			alg: 'RS256',
			kid: keys.kid
		}]
	};
}

function status() {
	return { available: !!cached, error: loadError, kid: cached ? cached.kid : null };
}

// Adopt key material handed over by a master (MULTI_SITE_SPEC.md §2, the same
// "identical directories" sync agent_keys.js does). Without this, a promotion
// or failover would move the issuer to a node signing with a different key, and
// every ID token and session in the cluster would stop validating at once.
//
// Idempotent: adopting the same material twice is a no-op past the first call.
async function adopt({ privateKeyPem, publicKeyPem }) {
	if (!privateKeyPem || !publicKeyPem) throw new Error('adopt() requires both privateKeyPem and publicKeyPem');
	if (cached && cached.privateKeyPem === privateKeyPem && cached.publicKeyPem === publicKeyPem) {
		return cached;
	}
	const material = { privateKeyPem, publicKeyPem };
	await baoConf.set(PATH, material);
	cached = decorate(material);
	loadError = null;
	console.log(`[oauth_keys] adopted ID token key from master (kid ${cached.kid})`);
	return cached;
}

// Test seam: drop the in-process cache.
function _reset() {
	cached = null;
	loadError = null;
}

module.exports = { load, jwks, status, adopt, _reset, PATH };
