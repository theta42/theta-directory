'use strict';

const router = require('express').Router();
const {User} = require('../models/user');
const {Group} = require('../models/group_ldap');
const permission = require('../utils/permission');
const {UserVerification} = require('../models/verification');
const {InviteToken} = require('../models/token');

router.get('/', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin'])
		return res.json({
			results:  await User[req.query.detail ? "listDetail" : "list"](),
		});
	}catch(error){
		next(error);
	}
});

router.post('/', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin'])

		req.body.created_by = req.user.uid
		req.body.manager = [req.user.dn];

		let user = await User.add(req.body);
		const verif = await UserVerification.getOrCreate(user.uid);
		const updates = { password_must_change: true };
		if (req.body.tosAgree) updates.tos_accepted = true, updates.tos_accepted_at = Date.now();
		await verif.update(updates);

		// Service accounts (a Unix account an app/service runs as, not a
		// person) are marked by membership in app_sso_service_account rather
		// than a schema change -- see models/user_ldap.js User.listDetail.
		if (req.body.isServiceAccount === true || req.body.isServiceAccount === 'true' || req.body.isServiceAccount === 'on') {
			try {
				const group = await Group.get('app_sso_service_account');
				await group.addMember(user);
				// User.add() already cached `user` (via its own internal
				// User.get()) before this group membership existed, so the
				// cached isServiceAccount would be stuck wrong for 5 minutes
				// (the cache TTL) without this -- re-fetch after clearing.
				User.clearCache();
				user = await User.get(user.uid);
			} catch (error) {
				console.error(`user.add: failed to mark ${user.uid} as a service account:`, error.message);
			}
		}

		return res.json({results: user});
	}catch(error){
		next(error);
	}
});

router.delete('/:uid', async function(req, res, next){
	try{
		let user;

		if(req.params.uid.toLowerCase() === req.user.uid.toLowerCase()){
			user = req.user;	
		}else{
			user = await User.get(req.params.uid);
			await permission.byGroup(req.user, ['app_sso_admin'])
		}

		return res.json({uid: req.params.uid, results: await user.remove()})
	}catch(error){
		next(error);
	}
});

router.get('/me', async function(req, res, next){
	try{
		return res.json(await User.get({uid: req.user.uid}));
	}catch(error){
		next(error);
	}
});

router.post('/accept-tos', async function(req, res, next){
	try{
		const verif = await UserVerification.getOrCreate(req.user.uid);
		await verif.markTosAccepted();
		User.clearCache();
		return res.json({ success: true });
	}catch(error){
		next(error);
	}
});

router.put('/password', async function(req, res, next){
	try{
		const result = await req.user.setPassword(req.body);
		const verif = await UserVerification.getOrCreate(req.user.uid);
		await verif.update({ password_must_change: false });
		User.clearCache();
		return res.json({results: result});
	}catch(error){
		next(error);
	}
});

router.put('/:uid/password', async function(req, res, next){
	try{
		let user;

		if(req.params.uid.toLowerCase() === req.user.uid.toLowerCase()){
			user = req.user;
		}else{
			user = await User.get(req.params.uid);
			await permission.byGroup(req.user, ['app_sso_admin'])
		}

		const result = await user.setPassword(req.body);
		if(req.params.uid.toLowerCase() !== req.user.uid.toLowerCase()){
			const verif = await UserVerification.getOrCreate(user.uid);
			await verif.update({ password_must_change: true });
		}
		return res.json({
			results: result,
			message: `User ${user.uid} password changed.`
		});
	}catch(error){
		next(error);
	}
});

router.put('/:uid/active', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin']);
		const user = await User.get(req.params.uid);
		const active = req.body.active !== false && req.body.active !== 'false';
		await user.setActive(active);
		return res.json({
			uid: req.params.uid,
			active,
			message: `User ${req.params.uid} ${active ? 'activated' : 'deactivated'}`
		});
	}catch(error){
		next(error);
	}
});

router.get('/:uid/group-members', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin']);
		return res.json({results: await User.getPersonalGroupMembers(req.params.uid)});
	}catch(error){
		next(error);
	}
});

router.put('/:uid/group-member/:memberUid', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin']);
		await User.addPersonalGroupMember(req.params.uid, req.params.memberUid);
		return res.json({
			results: true,
			message: `Added ${req.params.memberUid} to ${req.params.uid}'s group`
		});
	}catch(error){
		next(error);
	}
});

router.delete('/:uid/group-member/:memberUid', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin']);
		await User.removePersonalGroupMember(req.params.uid, req.params.memberUid);
		return res.json({
			results: true,
			message: `Removed ${req.params.memberUid} from ${req.params.uid}'s group`
		});
	}catch(error){
		next(error);
	}
});

router.put('/:uid', async function(req, res, next){
	try{
		let user;

		if(req.params.uid.toLowerCase() === req.user.uid.toLowerCase()){
			user = req.user;
		}else{
			user = await User.get(req.params.uid);
			const isManager = (user.manager || []).includes(req.user.dn);
			if(!isManager) await permission.byGroup(req.user, ['app_sso_admin'])
		}

		// The manager picker is a tag widget backed by a single newline-separated
		// hidden input (see public/js/app.js app.ui.userSelect), same convention
		// as oauth_client.js's allowed_groups.
		if (typeof req.body.manager === 'string') {
			req.body.manager = req.body.manager.split('\n').map(s => s.trim()).filter(Boolean);
		}

		return res.json({
			results: await user.update(req.body),
			message: `Updated ${req.params.uid} user`

		});
	}catch(error){
		next(error);
	}
});

router.post('/invite', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin', 'app_sso_invite']);
		const { mail, groups = [] } = req.body;
		const token = await req.user.invite({
			mail,
			groups,
			url: `${req.protocol}://${req.hostname}`,
		});
		return res.json({
			token:     token.token,
			link:      `${req.protocol}://${req.hostname}/login/invite/${token.token}`,
			mail_sent: !!mail,
		});
	}catch(error){
		next(error);
	}
});

router.get('/invite', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin', 'app_sso_invite']);
		const isAdmin = await permission.byGroup(req.user, ['app_sso_admin']).then(() => true).catch(() => false);
		const all = await InviteToken.list();
		const visible = isAdmin ? all : all.filter(t => t.created_by === req.user.uid);
		const results = visible.map(t => ({ token: t.token, ...t }));
		return res.json({ results });
	}catch(error){
		next(error);
	}
});

router.put('/invite/:token', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin', 'app_sso_invite']);
		const token = await InviteToken.get(req.params.token);
		const isAdmin = await permission.byGroup(req.user, ['app_sso_admin']).then(() => true).catch(() => false);
		if (!isAdmin && token.created_by !== req.user.uid) {
			const err = new Error('Insufficient Permission'); err.status = 401; throw err;
		}
		if (!token.is_valid) {
			const err = new Error('Token is no longer valid'); err.status = 400; throw err;
		}
		const update = {};
		if (req.body.groups !== undefined) {
			update.groups = JSON.stringify([].concat(req.body.groups || []));
		}
		if (req.body.mail !== undefined && req.body.mail !== token.mail) {
			if (req.body.mail) {
				await User.verifyEmail({ token: token.token, mail: req.body.mail, url: `${req.protocol}://${req.hostname}` });
				const refreshed = await InviteToken.get(token.token);
				update.mail       = refreshed.mail;
				update.mail_token = refreshed.mail_token;
			} else {
				update.mail       = '__NONE__';
				update.mail_token = '__NONE__';
			}
		}
		if (Object.keys(update).length) await token.update(update);
		const updated = await InviteToken.get(req.params.token);
		return res.json({ results: { token: updated.token, ...updated } });
	}catch(error){
		next(error);
	}
});

router.delete('/invite/:token', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin', 'app_sso_invite']);
		const token = await InviteToken.get(req.params.token);
		const isAdmin = await permission.byGroup(req.user, ['app_sso_admin']).then(() => true).catch(() => false);
		if (!isAdmin && token.created_by !== req.user.uid) {
			const err = new Error('Insufficient Permission'); err.status = 401; throw err;
		}
		await token.update({ is_valid: false });
		return res.json({ results: true });
	}catch(error){
		next(error);
	}
});

router.post('/key', async function(req, res, next){
	try{
		let added = await User.addSSHkey({
			uid: req.user.uid,
			key: req.body.key
		});

		return res.status(added === true ? 200 : 400).json({
			message: added
		});

	}catch(error){
		next(error);
	}

});

router.get('/:uid/verification', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin']);
		const verif = await UserVerification.getOrCreate(req.params.uid);
		return res.json({
			uid:             req.params.uid,
			emailVerified:   verif.email_verified,
			emailVerifiedAt: verif.email_verified_at || null,
			phoneVerified:   verif.phone_verified,
			phoneVerifiedAt: verif.phone_verified_at || null,
			tosAccepted:     verif.tos_accepted,
			tosAcceptedAt:   verif.tos_accepted_at || null,
		});
	}catch(error){
		next(error);
	}
});

router.get('/stats', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin']);
		const [users, groups] = await Promise.all([User.listDetail(), Group.list()]);
		const active   = users.filter(u => !u.pwdAccountLockedTime);
		const inactive = users.filter(u =>  u.pwdAccountLockedTime);
		const recent   = [...users]
			.sort((a, b) => (b.createTimestamp || '').localeCompare(a.createTimestamp || ''))
			.slice(0, 10)
			.map(u => ({ uid: u.uid, givenName: u.givenName, sn: u.sn, mail: u.mail, createTimestamp: u.createTimestamp }));
		return res.json({
			totalUsers:    users.length,
			activeUsers:   active.length,
			inactiveUsers: inactive.length,
			totalGroups:   groups.length,
			recentSignups: recent,
			inactiveList:  inactive.map(u => ({ uid: u.uid, givenName: u.givenName, sn: u.sn, mail: u.mail })),
		});
	}catch(error){
		next(error);
	}
});

router.get('/export', async function(req, res, next){
	try{
		await permission.byGroup(req.user, ['app_sso_admin']);
		const users = await User.listDetail();
		const headers = ['uid', 'givenName', 'sn', 'mail', 'mobile', 'uidNumber', 'isActive', 'createTimestamp'];
		const rows = users.map(u => headers.map(h => {
			const v = u[h] || '';
			return `"${String(v).replace(/"/g, '""')}"`;
		}).join(','));
		res.setHeader('Content-Type', 'text/csv');
		res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
		return res.send([headers.join(','), ...rows].join('\n'));
	}catch(error){
		next(error);
	}
});

router.get('/:uid', async function(req, res, next){
	try{
		return res.json({
			results:  await User.get(req.params.uid),
		});
	}catch(error){
		next(error);
	}
});

module.exports = router;
