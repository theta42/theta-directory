'use strict';

/**
 * Per-socket authorization for model events pushed over Socket.IO.
 *
 * The bridge here used to be `app.io.emit('P2PSub', {topic, data})` — every
 * event on the bus, with its full record, to every authenticated socket — plus
 * a `socket.on('P2PSub')` handler that republished whatever a client sent to
 * every other client.
 *
 * Nothing in this app publishes model events yet, so the outbound half carried
 * no traffic; the inbound half was a live topic-injection path used by nothing
 * (no app code calls app.publish()). Both are gone.
 *
 * READERS below is intentionally empty. Live updates should be added one model
 * at a time, each arriving WITH the read gate that decides who may see its
 * events — rather than the events going out first and the authorization being
 * retrofitted. Until a model is listed here, its events are not broadcast.
 *
 * To add one, mirror the model's REST read guard, e.g.:
 *
 *   Resource(user, record, pk){
 *     return canReadResource(user, record);
 *   }
 *
 * `user` is {username, groups}; `record` is the published payload (may be null
 * on a delete); `pk` comes from the topic.
 */

const READERS = {};

const warnedModels = new Set();

// `model:Resource:update:abc` -> {model, action, pk}
// A pk may itself contain ':' (LDAP DNs, IPv6 literals, composite keys), so
// the tail is rejoined rather than split off.
function parseTopic(topic){
	const parts = String(topic || '').split(':');
	if(parts[0] !== 'model' || parts.length < 3) return null;
	return {
		model: parts[1],
		action: parts[2],
		pk: parts.length > 3 ? parts.slice(3).join(':') : undefined,
	};
}

function socketUser(socket){
	if(!socket.user) return null;
	return {
		username: socket.user.username,
		groups: socket.groups || [],
	};
}

/**
 * Bridge the server-side pubsub bus onto authorized sockets.
 *
 * @param {Object} io - the Socket.IO server
 * @param {Object} ps - the p2psub bus (controller/pubsub)
 */
function attach(io, ps){
	ps.subscribe(/^model:/, function(data, topic){
		const event = parseTopic(topic);
		if(!event) return;

		const canRead = READERS[event.model];
		if(!canRead){
			// Fail closed, and say so once per model so a missing gate reads as
			// a missing gate rather than as a mysteriously dead live update.
			if(!warnedModels.has(event.model)){
				warnedModels.add(event.model);
				console.warn(`[socket_pubsub] no read gate for model '${event.model}'; its events are not broadcast. Add it to READERS in utils/socket_pubsub.js.`);
			}
			return;
		}

		for(const socket of io.sockets.sockets.values()){
			// authIO rejects unauthenticated sockets; skip rather than trust
			// one that somehow lacks a user.
			const user = socketUser(socket);
			if(!user) continue;

			let allowed = false;
			try{
				allowed = canRead(user, data, event.pk);
			}catch(error){
				console.error(`[socket_pubsub] read gate for '${event.model}' threw:`, error);
				allowed = false;
			}
			if(allowed) socket.emit('P2PSub', {topic, data});
		}
	});

	// Deliberately no `socket.on('P2PSub')`: events flow server -> client only.
}

module.exports = {attach, parseTopic, READERS};
