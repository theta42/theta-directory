'use strict';

// Service-to-service client for theta-proxy's Host management API --
// MULTI_SITE_SPEC.md's "no-inbound relay automation" (a master creating a
// relay route so a spoke with zero inbound path of its own is reachable).
//
// Deliberately does NOT invent a new credential type. theta-proxy already
// has a self-service API token system (models/api_token.js, `prx_<id>_<secret>`
// bearer tokens that authenticate as their creator's user + group snapshot --
// same pattern this app and jump-host both already have their own copy of).
// The "service-to-service auth" gap was never "no credential type exists" --
// it's that nothing wired one of these tokens into an actual inter-service
// call. This is that wiring, using the credential type that was already
// there. The token itself is operator-provisioned (minted on theta-proxy by
// an admin with Host-management rights) and stored in OpenBao, same as the
// agent-signing key in agent_keys.js.

const baoConf = require('@simpleworkjs/bao-conf');

const PATH = 'integrations/theta-proxy'; // baoConf adds the secret/data prefix
const REQUEST_TIMEOUT_MS = 10000;

let cachedToken = null;

async function loadToken() {
	if (cachedToken) return cachedToken;
	let stored;
	try {
		stored = await baoConf.get(PATH);
	} catch (err) {
		console.error(`[proxy_client] could not read ${PATH} from OpenBao: ${err.message}`);
		return null;
	}
	if (!stored || !stored.token) return null;
	cachedToken = stored.token;
	return cachedToken;
}

function proxyBaseUrl() {
	// Not OpenBao -- this is where the proxy's admin API lives, not a secret.
	// No safe default: relaying to a guessed host would be worse than
	// refusing, so this must be explicitly configured.
	return process.env.PROXY_INTERNAL_URL || '';
}

// Creates the relay Host route if missing, updates its target IP if it
// already exists and points somewhere else. Idempotent -- safe to call
// again for the same host on every spoke resync.
//
// Returns { note } describing what happened (created/updated/skipped/failed)
// rather than throwing on a missing token or base URL -- callers (spoke
// registration) must never fail the whole registration just because this
// automation isn't configured yet; it's an enhancement layered on top of a
// working join, not a requirement of one.
async function ensureRelayRoute({ host, ip, targetPort }) {
	if (!host || !ip || !targetPort) {
		return { note: 'skipped: host, ip, and targetPort are all required' };
	}
	const base = proxyBaseUrl();
	if (!base) {
		return { note: 'skipped: PROXY_INTERNAL_URL not configured' };
	}
	const token = await loadToken();
	if (!token) {
		return { note: `skipped: no proxy API token at OpenBao ${PATH} -- mint one on theta-proxy and store it there` };
	}

	const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const existing = await fetch(base.replace(/\/+$/, '') + '/api/host/' + encodeURIComponent(host), {
			headers, signal: controller.signal
		});

		if (existing.status === 200) {
			// GET /api/host/:item wraps the record in { item, results }, not
			// flat -- confirmed against a real running proxy (this check
			// silently always "updated" instead of no-op'ing until fixed).
			const body = await existing.json();
			const current = body.results || body;
			if (current.ip === ip && Number(current.targetPort) === Number(targetPort)) {
				return { note: 'already up to date' };
			}
			const put = await fetch(base.replace(/\/+$/, '') + '/api/host/' + encodeURIComponent(host), {
				method: 'PUT', headers, body: JSON.stringify({ ip, targetPort }), signal: controller.signal
			});
			return put.ok ? { note: 'updated' } : { note: `update failed: HTTP ${put.status}` };
		}

		const create = await fetch(base.replace(/\/+$/, '') + '/api/host', {
			method: 'POST', headers, body: JSON.stringify({ host, ip, targetPort }), signal: controller.signal
		});
		return create.ok ? { note: 'created' } : { note: `create failed: HTTP ${create.status}` };
	} catch (err) {
		return { note: `failed: ${err.message}` };
	} finally {
		clearTimeout(timer);
	}
}

// Test seam.
function _reset() { cachedToken = null; }

module.exports = { ensureRelayRoute, _reset, PATH };
