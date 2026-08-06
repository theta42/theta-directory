'use strict';

const https = require('https');
const conf = require('@simpleworkjs/conf').voipms;

function toE164Digits(number) {
	const digits = String(number).replace(/\D/g, '');
	if (digits.length === 10) return '1' + digits;
	return digits;
}

async function send(to, message) {
	const { PluginInstance } = require('./plugin_instance');
	const registry = require('../services/plugin_registry');
	const pluginSecrets = require('../utils/plugin_secrets');

	// @simpleworkjs/orm has no `find` -- the query method is `list({where})`.
	// `PluginInstance.find(...)` threw "is not a function" on EVERY call into
	// this sender, so SMS delivery never worked at all: not the test button, not
	// OTP-by-SMS, not notifications. It failed before it could even fall back to
	// the direct VoIP.ms path below.
	const instances = await PluginInstance.list({ where: { category: 'messaging', enabled: true } });
	if (instances.length > 0) {
		const inst = instances[0];
		const manifest = registry.getManifest(inst.pluginType);
		if (manifest && manifest.sendMessage) {
			const secrets = await pluginSecrets.read(inst.id).catch(() => ({}));
			const config = { ...inst.config, ...secrets };
			return manifest.sendMessage(config, { to, message });
		}
	}

	const params = new URLSearchParams({
		api_username: conf.username,
		api_password: conf.password,
		method: 'sendSMS',
		did: conf.did,
		dst: toE164Digits(to),
		message,
	});

	return new Promise((resolve, reject) => {
		https.get(`https://voip.ms/api/v1/rest.php?${params}`, res => {
			let body = '';
			res.on('data', d => body += d);
			res.on('end', () => {
				try {
					const json = JSON.parse(body);
					if (json.status !== 'success') {
						reject(new Error(`VoIP.ms error: ${json.status}`));
					} else {
						resolve(json);
					}
				} catch(e) {
					reject(new Error('VoIP.ms returned invalid JSON'));
				}
			});
		}).on('error', reject);
	});
}

module.exports = {SMS: {send}};
