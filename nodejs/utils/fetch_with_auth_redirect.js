'use strict';

// Node's fetch follows redirects automatically, but for 301/302 it changes the
// method to GET and drops the body and Authorization header. Theta proxies
// redirect HTTP to HTTPS with 301, so any internal POST that carries a bearer
// token can arrive at the destination without credentials.
//
// This helper follows same-host redirects manually, preserving method, body,
// and headers. It is shared by:
//   - site_replicate.js   (master -> spoke resync push)
//   - spoke_write_proxy.js (spoke -> master write forwarding)
//   - mesh_roster.js       (gateway identity push to master)
//   - proxy_client.js      (relay route automation)

const REDIRECT_CODES = new Set([301, 302, 307, 308]);
const MAX_REDIRECTS = 3;

async function fetchWithAuthRedirect(url, init, options = {}) {
	const timeoutMs = options.timeoutMs || 8000;
	let currentUrl = url;
	let currentInit = init;
	for (let depth = 0; depth <= MAX_REDIRECTS; depth++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const resp = await fetch(currentUrl, { ...currentInit, redirect: 'manual', signal: controller.signal });
			if (!REDIRECT_CODES.has(resp.status)) return resp;

			const location = resp.headers.get('location') || resp.headers.get('Location');
			if (!location) throw new Error(`status ${resp.status} but no Location header`);
			if (depth === MAX_REDIRECTS) throw new Error('too many redirects');

			const next = new URL(location, currentUrl);
			const original = new URL(currentUrl);
			// Only follow if the destination keeps the same host. This prevents
			// leaking bearer tokens to arbitrary third-party hosts while still
			// covering the http -> https scheme-upgrade case.
			if (next.host.toLowerCase() !== original.host.toLowerCase()) {
				throw new Error(`refusing cross-host redirect from ${original.host} to ${next.host}`);
			}
			currentUrl = next.href;
			// Re-use the same init (method, headers, body) for 307/308 semantics;
			// for 301/302 we also keep the POST body because this is an internal
			// API call where the redirect is known to be a scheme/alias upgrade.
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error('too many redirects');
}

module.exports = { fetchWithAuthRedirect, MAX_REDIRECTS, REDIRECT_CODES };
