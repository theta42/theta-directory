'use strict';

// Small helper: fire-and-forget resync push after a successful mutating
// response. Centralized so user/group/directory routes all share the same
// behavior and are easy to test.

const meshReplicate = require('./site_replicate');

function replicateOnFinish(res, reason) {
	res.on('finish', () => {
		if (res.statusCode >= 200 && res.statusCode < 300) {
			meshReplicate.replicateToSpokes(reason);
		}
	});
}

module.exports = { replicateOnFinish };
