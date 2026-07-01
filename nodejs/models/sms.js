'use strict';

const https = require('https');
const conf = require('@simpleworkjs/conf').voipms;

function toE164Digits(number) {
	const digits = String(number).replace(/\D/g, '');
	if (digits.length === 10) return '1' + digits;
	return digits;
}

async function send(to, message) {
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
