'use strict';

/**
 * Per-socket authorization for model events pushed over Socket.IO.
 *
 * The bridge here used to be `app.io.emit('P2PSub', {topic, data})` — every
 * event on the bus, with its full record, to every authenticated socket — plus
 * a `socket.on('P2PSub')` handler that republished whatever a client sent to
 * every other client. Both are gone: events flow server -> client only, and
 * each one is checked against the same rights the REST layer checks.
 *
 * READERS is the single source of truth for what goes live. A model listed here
 * both publishes (models/index.js only forwards events for these models onto
 * the bus) and is authorized here. A model that is not listed does neither, so
 * live updates cannot outrun their access check.
 *
 * To add one, mirror the model's REST read guard.
 */

const permission = require('./permission');

// How long a socket's resolved group membership is cached. Sockets are
// long-lived and membership is resolved from LDAP transitively, so without a
// cache every event would re-resolve for every connected client.
const GROUPS_TTL_MS = 30 * 1000;

// The gate used by routes/api_directory_admin.js (router.use, line ~191) and
// routes/api_plugins.js: app_sso_directory_admin or app_sso_admin, or a global
// super admin.
const DIRECTORY_ADMIN_GROUPS = ['app_sso_directory_admin', 'app_sso_admin'];

function isDirectoryAdmin(ctx){
	if(ctx.isSuperAdmin) return true;
	return DIRECTORY_ADMIN_GROUPS.some((g) => ctx.memberOfCns.includes(g));
}

const READERS = {
	// GET /api/directory-admin/resources — whole router is admin-gated.
	Resource(ctx){
		return isDirectoryAdmin(ctx);
	},

	// GET /api/directory-admin/groups — same router, same gate.
	ResourceGroup(ctx){
		return isDirectoryAdmin(ctx);
	},

	// GET /api/plugins — routes/api_plugins.js applies the same admin gate.
	PluginInstance(ctx){
		return isDirectoryAdmin(ctx);
	},

	// The parent/child edges the Directory tree is derived from; served by the
	// same admin-gated router as the resources themselves.
	ResourceEdge(ctx){
		return isDirectoryAdmin(ctx);
	},

	// GET /api/group (routes/group.js:8) has no authz guard: any authenticated
	// user may list groups today. Mirrored rather than tightened here on
	// purpose — a socket stricter than the endpoint feeding the same page shows
	// a list that silently stops updating, which reads as a broken page rather
	// than a security control. Tighten the route and this follows automatically.
	Group(){
		return true;
	},

	// GET /api/user requires app_sso_admin, but GET /api/user/me is self-service
	// — so an admin sees every user, and everyone else sees only their own
	// record. Row-level, not just model-level.
	User(ctx, record, pk){
		if (isDirectoryAdmin(ctx) || ctx.memberOfCns.includes('app_sso_admin')) return true;
		const self = ctx.user && ctx.user.uid;
		if (!self) return false;
		const subject = (record && (record.uid || record.username)) || pk;
		return !!subject && String(subject) === String(self);
	},

	// GET /api/notification is owner-scoped (routes/notification.js).
	Notification(ctx, record, pk){
		if (isDirectoryAdmin(ctx)) return true;
		const self = ctx.user && ctx.user.uid;
		const owner = record && (record.uid || record.created_by || record.username);
		return !!self && !!owner && String(owner) === String(self);
	},

	// Self-service PATs (routes/api_token.js) — owner-scoped, never anyone else's.
	ApiToken(ctx, record, pk){
		const self = ctx.user && ctx.user.uid;
		const owner = record && (record.created_by || record.uid);
		return !!self && !!owner && String(owner) === String(self);
	},

	// Mesh views (views/mesh.ejs). Client enrolment is per-user; the roster and
	// exit grants are admin-facing.
	MeshClient(ctx, record, pk){
		if (isDirectoryAdmin(ctx)) return true;
		const self = ctx.user && ctx.user.uid;
		const owner = record && (record.uid || record.username || record.created_by);
		return !!self && !!owner && String(owner) === String(self);
	},

	MeshSite(ctx){
		return isDirectoryAdmin(ctx);
	},

	MeshExitGrant(ctx){
		return isDirectoryAdmin(ctx);
	},

	// Self-service access requests: any authenticated user may raise one and see
	// their own; deciding is gated per-resource inside the router, and a
	// directory admin sees all of them.
	AccessRequest(ctx, record, pk){
		if (isDirectoryAdmin(ctx)) return true;
		const self = ctx.user && ctx.user.uid;
		const requester = record && (record.uid || record.requestedBy || record.created_by);
		return !!self && !!requester && String(requester) === String(self);
	},

	// theta-agent enrolment state, rendered on the Directory page.
	Agent(ctx){
		return isDirectoryAdmin(ctx);
	},
};

// Models whose events are forwarded onto the bus at all. Derived from READERS
// so the two can never drift: publishing something with no gate would be a
// leak, and gating something that never publishes would be dead code.
const LIVE_MODELS = new Set(Object.keys(READERS));

// ── non-model channels ───────────────────────────────────────────────────────
//
// Not everything pushed to a browser is a model event. theta-agent streams
// telemetry, discovery results and command output over its own WebSocket, and
// those were sent with a bare `app.io.emit` — every frame to every
// authenticated socket, with no read check at all.
//
// `agent.response` carries the OUTPUT of commands run on a host, on a channel
// this app's own comments describe as able to "run arbitrary bash". `agent.
// discovery` carries host inventory (open ports, services). Neither is
// something every logged-in user should receive.
//
// These mirror the REST gate on routes/api_agent.js, which is admin-only for
// the whole router (ADMIN_GROUPS there).
const AGENT_ADMIN_GROUPS = ['app_sso_admin', 'app_super_admin', 'app_sso_directory_admin'];

function isAgentAdmin(ctx){
	if(ctx.isSuperAdmin) return true;
	return AGENT_ADMIN_GROUPS.some((g) => ctx.memberOfCns.includes(g));
}

const CHANNELS = {
	'agent.telemetry': isAgentAdmin,
	'agent.discovery': isAgentAdmin,
	'agent.response': isAgentAdmin,
};

const warnedModels = new Set();

// `model:Resource:update:abc` -> {model, action, pk}
// A pk may itself contain ':' (LDAP DNs, IPv6 literals, composite keys), so the
// tail is rejoined rather than split off.
function parseTopic(topic){
	const parts = String(topic || '').split(':');
	if(parts[0] !== 'model' || parts.length < 3) return null;
	return {
		model: parts[1],
		action: parts[2],
		pk: parts.length > 3 ? parts.slice(3).join(':') : undefined,
	};
}

/**
 * The bus every model publishes through — ORM-managed or not.
 *
 * Passed to `@simpleworkjs/orm`'s `init({pubsub})` hook, and bound into
 * utils/model_events for models the ORM does not manage (LDAP groups and users,
 * Redis-backed notifications). One filter for both, so "does this model have a
 * read gate?" is answered in exactly one place.
 *
 * The filter matters most for the ORM, which publishes for every model it loads
 * — here that includes AuthToken, OtpToken and PasswordResetToken, written on
 * every login and every password reset. Those must never reach a browser, and
 * would be constant churn besides.
 */
function liveBus(ps){
	return {
		publish(topic, data){
			if(data && LIVE_MODELS.has(data.model)) ps.publish(topic, data);
		},
		subscribe(pattern, listener){
			return ps.subscribe(pattern, listener);
		},
	};
}

// Resolve (and briefly cache) a socket's group membership, the same way
// utils/permission.byGroup does: transitively from LDAP, so a user who is an
// admin through a nested group is treated as one.
async function contextFor(socket){
	const now = Date.now();
	if(socket._authzCtx && socket._authzCtxAt > now - GROUPS_TTL_MS){
		return socket._authzCtx;
	}

	const {Group} = require('../models/group_ldap');
	let memberOfCns = [];
	try{
		memberOfCns = await Group.list(socket.user.dn);
	}catch(error){
		// Deny rather than guess if membership cannot be resolved.
		memberOfCns = [];
	}

	socket._authzCtx = {
		user: socket.user,
		memberOfCns,
		isSuperAdmin: await permission.isSuperAdmin(memberOfCns),
	};
	socket._authzCtxAt = now;
	return socket._authzCtx;
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
			// Fail closed, and say so once per model so a missing gate reads as a
			// missing gate rather than a mysteriously dead live update.
			if(!warnedModels.has(event.model)){
				warnedModels.add(event.model);
				console.warn(`[socket_pubsub] no read gate for model '${event.model}'; its events are not broadcast. Add it to READERS in utils/socket_pubsub.js.`);
			}
			return;
		}

		for(const socket of io.sockets.sockets.values()){
			// authIO rejects unauthenticated sockets; skip rather than trust one
			// that somehow lacks a user or a dn to resolve groups from.
			if(!socket.user || !socket.user.dn) continue;

			contextFor(socket).then(function(ctx){
				let allowed = false;
				try{
					allowed = canRead(ctx, data, event.pk);
				}catch(error){
					console.error(`[socket_pubsub] read gate for '${event.model}' threw:`, error);
					allowed = false;
				}
				if(allowed) socket.emit('P2PSub', {topic, data});
			}).catch(function(error){
				console.error('[socket_pubsub] could not resolve rights for socket:', error);
			});
		}
	});

	// Deliberately no `socket.on('P2PSub')`: events flow server -> client only.
}

/**
 * Emit on a non-model channel, to the sockets allowed to receive it.
 *
 * Drop-in for `io.emit(channel, data)` — which is what these were, and why
 * command output was reaching every connected browser.
 *
 * A channel with no entry in CHANNELS is not sent at all: same fail-closed rule
 * as models, so a new push channel cannot start broadcasting before someone
 * decides who may see it.
 */
function emitChannel(io, channel, data){
	if(!io) return;

	const canRead = CHANNELS[channel];
	if(!canRead){
		if(!warnedModels.has('channel:' + channel)){
			warnedModels.add('channel:' + channel);
			console.warn(`[socket_pubsub] no read gate for channel '${channel}'; it is not broadcast. Add it to CHANNELS in utils/socket_pubsub.js.`);
		}
		return;
	}

	for(const socket of io.sockets.sockets.values()){
		if(!socket.user || !socket.user.dn) continue;

		contextFor(socket).then(function(ctx){
			let allowed = false;
			try{
				allowed = canRead(ctx, data);
			}catch(error){
				console.error(`[socket_pubsub] read gate for channel '${channel}' threw:`, error);
				allowed = false;
			}
			if(allowed) socket.emit(channel, data);
		}).catch(function(error){
			console.error('[socket_pubsub] could not resolve rights for socket:', error);
		});
	}
}

module.exports = {attach, parseTopic, liveBus, emitChannel, READERS, LIVE_MODELS, CHANNELS};
