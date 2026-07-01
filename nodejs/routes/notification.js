'use strict';

const router = require('express').Router();
const {User} = require('../models/user_ldap');
const {Group} = require('../models/group_ldap');
const {Notification} = require('../models/notification');
const {Mail} = require('../models/email');
const permission = require('../utils/permission');

async function resolveRecipients(filter_type, filter_value, active_only) {
	if (filter_type === 'all' || filter_type === 'all_active') {
		const users = await User.listDetail();
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
		const uids = JSON.parse(filter_value);
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
		});

		let sent = 0, failed = 0;
		for (const user of recipients) {
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
		}

		await record.update({ status: 'sent', sent_count: sent, failed_count: failed, sent_at: Date.now() });

		return res.json({ results: record });
	} catch(e) {
		next(e);
	}
});

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
