'use strict';

const router = require('express').Router();
const {User} = require('../models/user_ldap');
const {Group} = require('../models/group_ldap');
const {Notification} = require('../models/notification');
const {Mail} = require('../models/email');
const permission = require('../utils/permission');

async function resolveRecipients(filter_type, filter_value, active_only) {
	if (filter_type === 'all' || filter_type === 'all_active') {
		// Service accounts (media managers, app service users, ...) aren't
		// read by anyone -- a broadcast to "all users" shouldn't include them.
		// Target one explicitly via filter_type=users/group if it ever needs
		// its own notification.
		const users = (await User.listDetail()).filter(u => !u.isServiceAccount);
		const active = filter_type === 'all_active' || active_only;
		return active ? users.filter(u => !u.pwdAccountLockedTime) : users;
	}

	if (filter_type === 'group') {
		const groupNames = filter_value.split(',').map(s => s.trim()).filter(Boolean);
		const groups = await Promise.all(groupNames.map(name => Group.get(name).catch(() => null)));
		const dnSet = new Set();
		groups.filter(Boolean).forEach(group => {
			[].concat(group.member || []).forEach(dn => dnSet.add(dn));
		});
		const uids = [...dnSet].map(dn => {
			const m = dn.match(/^uid=([^,]+)/i);
			return m ? m[1] : null;
		}).filter(Boolean);
		const users = (await Promise.all(uids.map(uid => User.get(uid).catch(() => null)))).filter(Boolean);
		return active_only ? users.filter(u => !u.pwdAccountLockedTime) : users;
	}

	if (filter_type === 'users') {
		// Unguarded, this threw a raw SyntaxError out of the handler and the
		// caller got a 500 for what is plainly a bad request.
		let uids;
		try {
			uids = JSON.parse(filter_value);
		} catch (e) {
			throw Object.assign(new Error('filter_value must be a JSON array of uids'), { status: 400 });
		}
		if (!Array.isArray(uids)) {
			throw Object.assign(new Error('filter_value must be a JSON array of uids'), { status: 400 });
		}
		const users = await Promise.all(uids.map(uid => User.get(uid).catch(() => null)));
		return users.filter(Boolean);
	}

	throw Object.assign(new Error('Invalid filter_type'), { status: 400 });
}

router.post('/', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, ['app_sso_admin']);

		const { subject, message, filter_type, filter_value = '', active_only = false } = req.body;
		if (!subject || !message || !filter_type) {
			return res.status(400).json({ name: 'ValidationError', message: 'subject, message, and filter_type are required' });
		}

		const recipients = await resolveRecipients(filter_type, filter_value, active_only);

		const record = await Notification.create({
			created_by:   req.user.uid,
			subject,
			message,
			filter_type,
			filter_value: String(filter_value),
			active_only:  Boolean(active_only),
			recipient_count: recipients.length,
		});

		// Answer now; send in the background.
		//
		// This loop was awaited inside the handler, one SMTP round-trip per
		// recipient, in series. A broadcast to a few hundred users is a few
		// hundred serial conversations with the mail server before the admin's
		// browser hears anything -- and OpenResty gives up long before that. The
		// send then continued server-side with nobody to report to, and because
		// the status only flipped to `sent` AFTER the loop, the record sat at
		// `sending` with `sent_count: 0` for good: no way to tell what actually
		// went out, and no way to retry.
		//
		// The record is the receipt, so returning it immediately is the honest
		// answer to "did you accept this?". Progress is written to the row as it
		// goes, and Notification publishes model events, so the history panel
		// follows along live rather than needing a reload.
		sendInBackground(record, recipients, { subject, message });

		return res.json({ results: record });
	} catch(e) {
		next(e);
	}
});

// How often to write progress back to the row while a send is running. Every
// recipient would be a write (and a socket event) per email; never would leave
// a long send looking hung. 25 is roughly a screenful of progress on a big
// broadcast without making the bus chatty.
const PROGRESS_EVERY = 25;

async function sendInBackground(record, recipients, { subject, message }) {
	let sent = 0, failed = 0;
	try {
		for (let i = 0; i < recipients.length; i++) {
			const user = recipients[i];
			if (!user.mail) { failed++; continue; }
			try {
				await Mail.sendTemplate(user.mail, 'notification', {
					givenName: user.givenName || user.uid,
					subject,
					message,
				});
				sent++;
			} catch(e) {
				console.error(`Notification send failed for ${user.uid}:`, e.message);
				failed++;
			}
			if ((i + 1) % PROGRESS_EVERY === 0) {
				await record.update({ sent_count: sent, failed_count: failed }).catch(() => {});
			}
		}
		await record.update({ status: 'sent', sent_count: sent, failed_count: failed, sent_at: Date.now() });
	} catch(e) {
		// Something outside an individual send broke -- the store, most likely.
		// Record it rather than leaving the row claiming to still be sending.
		console.error(`Notification ${record.notification_id} aborted:`, e.message);
		await record.update({
			status: 'failed', sent_count: sent, failed_count: failed, sent_at: Date.now(),
		}).catch(() => {});
	}
}

router.get('/', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, ['app_sso_admin']);
		const list = await Notification.listDetail();
		list.sort((a, b) => (b.created_on || 0) - (a.created_on || 0));
		return res.json({ results: list });
	} catch(e) {
		next(e);
	}
});

router.get('/:id', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, ['app_sso_admin']);
		return res.json({ results: await Notification.get(req.params.id) });
	} catch(e) {
		next(e);
	}
});

module.exports = router;
