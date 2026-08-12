'use strict';

// The notification feed: every model event that went out over the socket,
// replayed through the same read gates that decided who received it live.
//
// There is no per-recipient storage. socket_pubsub already answers "who may see
// this", per row, so history is just those events filtered by the same gate for
// whoever is asking. Unread is a single watermark per user rather than a read
// flag per item.

const router = require('express').Router();
const socketPubsub = require('../utils/socket_pubsub');
const {recent} = require('../models/activity_event');
const {ActivitySeen} = require('../models/activity_seen');

const FEED_LIMIT = 200;

// Apply the same gate the socket applied. The gates take (ctx, record, pk) and
// identify a record by its pk for most models; the owner-scoped ones read a
// field we stored alongside.
function visibleTo(ctx, event){
	const canRead = socketPubsub.READERS[event.model];
	if(!canRead) return false;
	try{
		return !!canRead(ctx, {
			// Enough of a record for the gates: the identifying field is the
			// pk for most models, and `owner` covers the owner-scoped ones.
			uid: event.owner || undefined,
			username: event.owner || undefined,
			created_by: event.owner || undefined,
			host: event.target || undefined,
		}, event.target);
	}catch(error){
		console.error(`[activity] read gate for '${event.model}' threw:`, error.message);
		return false;
	}
}

// GET /api/activity — the caller's feed, newest first, with an unread count.
router.get('/', async function(req, res, next){
	try{
		const ctx = await socketPubsub.contextForUser(req.user);
		const events = (await recent(FEED_LIMIT)).filter(e => visibleTo(ctx, e));

		let seenAt = 0;
		try{
			const row = await ActivitySeen.get(req.user.uid);
			seenAt = Number(row.seen_at) || 0;
		}catch(error){ /* never looked, everything is unread */ }

		return res.json({
			results: events,
			unread: events.filter(e => Number(e.created_on) > seenAt).length,
			seen_at: seenAt,
		});
	}catch(error){
		next(error);
	}
});

// PUT /api/activity/seen — move the watermark. One row per user, no per-item
// read flags: opening the feed marks everything up to now as seen, and because
// the count is derived from the watermark it clears on every device at once.
router.put('/seen', async function(req, res, next){
	try{
		const seen_at = Number(req.body && req.body.seen_at) || Date.now();
		await ActivitySeen.set(req.user.uid, seen_at);
		return res.json({results: {seen_at}});
	}catch(error){
		next(error);
	}
});

module.exports = router;
