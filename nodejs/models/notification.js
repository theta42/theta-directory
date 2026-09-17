'use strict';

const Table = require('.');
const {withEvents} = require('../utils/model_events');
const UUID = function b(a){return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,b)};

class Notification extends Table {
	static _key = 'notification_id';
	static _keyMap = {
		notification_id: { default: UUID,            type: 'string' },
		created_by:      { isRequired: true,          type: 'string' },
		created_on:      { default: () => Date.now()                 },
		subject:         { isRequired: true,          type: 'string' },
		message:         { isRequired: true,          type: 'string' },
		filter_type:     { isRequired: true,          type: 'string' },
		filter_value:    { default: '',               type: 'string' },
		active_only:     { default: false,            type: 'boolean' },
		// sending -> sent | failed. `sending` is now a real state rather than a
		// value that existed for the microseconds before the row was rewritten:
		// the send runs in the background and writes progress as it goes.
		status:          { default: 'sending',        type: 'string' },
		sent_count:      { default: 0,                type: 'number' },
		failed_count:    { default: 0,                type: 'number' },
		// How many the send started with, so progress means something while it
		// is running: without it, `sent_count: 40` could be finished or barely
		// begun.
		recipient_count: { default: 0,                type: 'number' },
		sent_at:         { default: 0,                type: 'number' },
	};

	// A background send that was interrupted -- a restart, a deploy, an OOM --
	// leaves its row claiming to still be sending, forever. Nothing resumes it,
	// so the honest thing is to say so at boot rather than let the history
	// panel show a broadcast permanently in flight.
	//
	// Deliberately not a resume: re-sending would re-deliver to everyone the
	// first run already reached, and the row does not record who those were.
	// An operator who needs the rest sent can send it again to a narrower
	// filter, which is a decision only they can make.
	static async markInterrupted() {
		try {
			const rows = await this.listDetail();
			const stuck = (rows || []).filter((r) => r.status === 'sending');
			for (const row of stuck) {
				const rec = await this.get(row.notification_id).catch(() => null);
				if (!rec) continue;
				await rec.update({ status: 'interrupted' }).catch(() => {});
			}
			if (stuck.length) {
				console.warn(`[Notification] ${stuck.length} send(s) were interrupted by a restart and will not resume.`);
			}
			return stuck.length;
		} catch (err) {
			console.error('[Notification] could not sweep interrupted sends:', err.message);
			return 0;
		}
	}
}
Notification.register();
// Announce writes on the standard contract; the Overview page's history
// panel subscribes. The socket gate is owner-scoped (utils/socket_pubsub.js).
withEvents(Notification, 'Notification');

module.exports = { Notification };
