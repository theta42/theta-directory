'use strict';

/**
 * The standardized way for a model to announce that it changed.
 *
 * `@simpleworkjs/orm` already does this for models it manages: on save/delete it
 * publishes `model:<Name>:<action>` with `{model, action, pk, data}`. Models
 * whose storage the ORM does not manage — LDAP groups and users, Redis-backed
 * notifications, secrets held in OpenBao — had no equivalent, so nothing they
 * changed ever reached a browser.
 *
 * Where the bytes live is not a reason to be exempt: those records are created
 * and mutated by code in this repo, and that code can say so. This module gives
 * it the identical contract, so a subscriber cannot tell (and does not care)
 * which backend a model uses:
 *
 *     topic    model:<Name>:<action>            action: create | update | delete
 *     payload  {model, action, pk, data}        data: null on delete
 *
 * `data` goes through `toJSON()` when the record defines one, so `isPrivate`
 * fields are stripped before they ever reach the bus — the same guarantee the
 * ORM's own publish path gives.
 *
 * Usage:
 *
 *     const events = require('./model_events');
 *     events.bind(liveBus);                       // once, at boot
 *     events.emit('Group', 'update', cn, group);   // in the mutator
 *
 * NOTE: this is intended to be upstreamed into `@simpleworkjs/orm` so every app
 * gets it from the framework rather than reimplementing it. It lives here until
 * a version carrying it is published; the API is deliberately the one it will
 * have there, so the swap is an import change.
 */

let bus = null;

/**
 * Point the emitter at a pub/sub bus. Pass the *filtered* bus
 * (utils/socket_pubsub.liveBus) so bespoke models get the same
 * gate-derived allowlist the ORM's events go through — a model with no read
 * gate should not reach the bus whatever its storage.
 */
function bind(pubsub){
	bus = pubsub;
}

/**
 * Announce a change.
 *
 * @param {string} model  - model name, as it appears in a topic and in READERS
 * @param {string} action - 'create' | 'update' | 'delete'
 * @param {*} pk          - primary key of the record
 * @param {Object} [record] - the record; omit (or null) for a delete
 */
function emit(model, action, pk, record){
	if (!bus) return;
	let data = null;
	// A delete never carries a body, whatever the caller passed. Enforced here
	// rather than trusted to each call site: the pk is all a subscriber needs to
	// drop a row, and a deleted record's contents are exactly the thing least
	// worth putting on a bus.
	if (record && action !== 'delete') {
		data = typeof record.toJSON === 'function' ? record.toJSON() : record;
	}
	try {
		bus.publish(`model:${model}:${action}`, {model, action, pk, data});
	} catch (error) {
		// A model must never fail its own write because an announcement failed.
		console.error(`[model_events] publishing ${model}:${action} failed:`, error.message);
	}
}

module.exports = {bind, emit};
