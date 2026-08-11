'use strict';

// Service-to-service client for jump-host's mesh registry -- used by the
// Directory's Multi-Site & Network Gateway Status modal to show the real
// number of gateway-to-gateway WireGuard mesh peers (see MULTI_SITE_SPEC.md),
// instead of counting the unrelated older WireGuard roaming-client/exit-node
// Resources in this app's own catalog (a different subsystem entirely --
// api_directory_admin.js used to filter Resource.list() for
// metadata.subType === 'wireguard', which has nothing to do with the mesh).
//
// Same pattern as utils/proxy_client.js: reuses jump-host's existing
// self-service API token system (models/api_token.js, `jmp_<id>_<secret>`
// bearer tokens) rather than inventing a new credential type. The token must
// be minted by a jump-admin user (GET /api/mesh/gateways requires
// requireJumpAdmin, which checks the token's creator's username/groups, not
// anything the token itself carries) and stored in OpenBao.

const baoConf = require('@simpleworkjs/bao-conf');

const PATH = 'integrations/theta-jump'; // baoConf adds the secret/data prefix
const REQUEST_TIMEOUT_MS = 10000;

let cachedToken = null;

async function loadToken() {
	if (cachedToken) return cachedToken;
	let stored;
	try {
		stored = await baoConf.get(PATH);
	} catch (err) {
		console.error(`[jump_client] could not read ${PATH} from OpenBao: ${err.message}`);
		return null;
	}
	if (!stored || !stored.token) return null;
	cachedToken = stored.token;
	return cachedToken;
}

function jumpBaseUrl() {
	// Not OpenBao -- this is where jump-host's admin API lives, not a secret.
	return process.env.JUMP_INTERNAL_URL || '';
}

// Returns { count, note }. count is null (not 0) when the query couldn't run
// at all (not configured, unreachable, unauthorized) -- the modal shows a
// count of gateways it could actually see, not a misleading "0" that reads
// as "you have no mesh peers" when the truth is "this isn't wired up yet".
async function getGatewayCount() {
	const base = jumpBaseUrl();
	if (!base) {
		return { count: null, note: 'skipped: JUMP_INTERNAL_URL not configured' };
	}
	const token = await loadToken();
	if (!token) {
		return { count: null, note: `skipped: no jump-host API token at OpenBao ${PATH} -- mint one on jump-host (as a jump-admin user) and store it there` };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const resp = await fetch(base.replace(/\/+$/, '') + '/api/mesh/gateways', {
			headers: { Authorization: 'Bearer ' + token },
			signal: controller.signal
		});
		if (!resp.ok) {
			return { count: null, note: `failed: HTTP ${resp.status}` };
		}
		const body = await resp.json();
		const gateways = Array.isArray(body.gateways) ? body.gateways : [];
		return { count: gateways.length, note: 'ok' };
	} catch (err) {
		return { count: null, note: `failed: ${err.message}` };
	} finally {
		clearTimeout(timer);
	}
}

// Test seam.
function _reset() { cachedToken = null; }

module.exports = { getGatewayCount, _reset, PATH };
