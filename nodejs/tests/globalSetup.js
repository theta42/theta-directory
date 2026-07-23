'use strict';

// Flush all test-prefix Redis keys before each test run so state is always clean.
// Uses model-redis's own bundled redis client since redis is not a top-level dep.
const { createClient } = require('redis');

module.exports = async function() {
	const client = createClient();
	await client.connect();

	const keys = await client.keys('sso_manager_test_*');
	if (keys.length) {
		await client.del(keys);
		console.log(`[globalSetup] Flushed ${keys.length} test Redis key(s).`);
	} else {
		console.log('[globalSetup] No test Redis keys to flush.');
	}

	await client.quit();
};
