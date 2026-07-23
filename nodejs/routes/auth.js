'use strict';

const crypto = require('crypto');
const router = require('express').Router();
const {User} = require('../models/user');
const {Auth, AuthToken} = require('../models/auth');
const {PasswordResetToken, ImpersonationToken, OtpToken} = require('../models/token');
const {hashPasswordSSHA512} = require('../models/user_ldap');
const {UserVerification} = require('../models/verification');
const {SMS} = require('../models/sms');
const {Mail} = require('../models/email');
const middleware = require('../middleware/auth');
const rateLimit = require('../middleware/rate_limit');
const permission = require('../utils/permission');
const conf = require('@simpleworkjs/conf');
const metrics = require('../utils/metrics');

async function findUserByLogin(login) {
	try {
		return await User.get(login);
	} catch(e) {
		if (e.status === 404 || e.name === 'UserNotFound') {
			return await User.get({searchKey: 'mail', searchValue: login});
		}
		throw e;
	}
}


router.get('/username-suggestions', async function(req, res, next) {
	try {
		const { givenName, sn, dob } = req.query;
		if (!givenName || !sn) return res.json({ suggestions: [] });
		return res.json({ suggestions: await User.usernameSuggestions(givenName, sn, dob) });
	} catch(e) { next(e); }
});

router.post('/login', rateLimit.login, async function(req, res, next){
	try{
		let auth = await Auth.login(req.body);
		metrics.recordServiceUsage('SSO Web UI', req.body.uid);
		return res.json({
			login: true,
			token: auth.token.token,
			message:`${req.body.uid} logged in!`,
		});
	}catch(error){
		if (error.name === 'LDAPLoginFailed' || error.status === 401 || error.name === 'UserNotFound') {
			metrics.recordFailedLogin(req.ip, req.body.uid);
		}
		next(error);
	}
});

router.all('/logout', async function(req, res, next){
	try{
		if(req.user){
			await req.user.logout();
		}

		res.json({message: 'Bye'})
	}catch(error){
		next(error);
	}
});

router.post('/resetpassword', rateLimit.passwordReset, async function(req, res, next){
	try{
		let sent = await User.passwordReset(`${req.protocol}://${req.hostname}`, req.body.mail);

		console.info('resetpassword for', req.body.mail, 'sent')

		return res.json({
			message: 'If the email address is in our system, you will receive a message.'
		});
	}catch(error){
		next(error);
	}
});

router.post('/resetpassword/:token', rateLimit.passwordReset, async function(req, res, next){
	try{
		let token = await PasswordResetToken.get(req.params.token);

		if(token.is_valid && 86400000+Number(token.created_on) > (new Date).getTime()){
			let user = await User.get(token.created_by);
			await user.setPassword(req.body);
			await token.update({is_valid: false});
			return res.json({
				message: 'Password has been changed.'
			});
		}

		let error = new Error('TokenExpired');
		error.name = 'TokenExpired';
		error.message = 'Password reset token is invalid or has expired.';
		error.status = 401;
		throw error;
	}catch(error){
		next(error);
	}
});

router.post('/invite/:token/:mailToken', rateLimit.invite, async function(req, res, next) {
	try{
		req.body.token = req.params.token;
		req.body.mailToken = req.params.mailToken;
		let user = await User.addByInvite(req.body);
		let token = await AuthToken.create(user);

		return res.json({
			user: user.uid,
			token: token.token
		});

	}catch(error){
		next(error);
	}

});

router.post('/invite/:token', rateLimit.invite, async function(req, res, next){
	try{
		let data = {
			token: req.params.token,
			url: `${req.protocol}://${req.hostname}`,
			mail: req.body.mail,
		}

		await User.verifyEmail(data);
		return res.send({message: 'sent'});
	}catch(error){
		next(error)
	}
});

router.post('/otp/request', rateLimit.otpRequest, async function(req, res, next) {
	try {
		const {login, method} = req.body;
		if (!login || !method) {
			return res.status(400).json({message: 'login and method are required'});
		}

		const user = await findUserByLogin(login);

		if (method === 'sms' && !user.mobile) {
			return res.status(400).json({message: 'No phone number on file for this account'});
		}

		const otp = await OtpToken.issue(user.uid, method);

		if (method === 'email') {
			await Mail.sendTemplate(user.mail, 'otp_code', {givenName: user.givenName, code: otp.code});
		} else if (method === 'sms') {
			try {
				await SMS.send(user.mobile, `Your ${conf.name} login code: ${otp.code}`);
			} catch (smsErr) {
				const err = new Error('SMS delivery failed. Please try email or contact your administrator.');
				err.status = 502;
				throw err;
			}
		} else {
			return res.status(400).json({message: 'method must be email or sms'});
		}

		return res.json({message: 'Code sent', method, expires_at: otp.expires_at});
	} catch(error) {
		next(error);
	}
});

router.post('/otp/verify', rateLimit.otpVerify, async function(req, res, next) {
	try {
		const {login, code} = req.body;
		if (!login || !code) {
			return res.status(400).json({message: 'login and code are required'});
		}

		const user = await findUserByLogin(login);
		const otp = await OtpToken.verify(user.uid, String(code));

		if (!otp) {
			const error = new Error('Invalid or expired code');
			error.status = 401;
			throw error;
		}

		const verif = await UserVerification.getOrCreate(user.uid);
		if (otp.method === 'email') await verif.markEmailVerified();
		if (otp.method === 'sms') await verif.markPhoneVerified();

		const authToken = await AuthToken.create(user);
		return res.json({login: true, token: authToken.token});
	} catch(error) {
		next(error);
	}
});

router.post('/impersonate/:uid', middleware.auth, async function(req, res, next) {
	try {
		await permission.byGroup(req.user, ['app_sso_admin']);

		const target = await User.get(req.params.uid);

		// Clean up any existing impersonation for this target
		const existing = await ImpersonationToken.listDetail({ target_uid: target.uid });
		for (const old of existing) {
			if (old.is_valid && !old.isExpired) {
				try { await target.removeTempPassword(old.temp_hash); } catch(_) {}
			}
			await old.update({ is_valid: false });
		}

		const tempPassword = crypto.randomBytes(16).toString('base64url');
		const tempHash = hashPasswordSSHA512(tempPassword);

		await target.addTempPassword(tempHash);

		const token = await ImpersonationToken.add({
			admin_uid: req.user.uid,
			target_uid: target.uid,
			temp_hash: tempHash,
		});

		return res.json({
			uid: target.uid,
			temp_password: tempPassword,
			expires_at: token.expires_at,
		});
	} catch(error) {
		next(error);
	}
});

router.delete('/impersonate/:uid', middleware.auth, async function(req, res, next) {
	try {
		await permission.byGroup(req.user, ['app_sso_admin']);

		const target = await User.get(req.params.uid);
		const existing = await ImpersonationToken.listDetail({ target_uid: target.uid });

		let revoked = 0;
		for (const token of existing) {
			if (token.is_valid) {
				try { await target.removeTempPassword(token.temp_hash); } catch(_) {}
				await token.update({ is_valid: false });
				revoked++;
			}
		}

		return res.json({ message: `Impersonation ended for ${target.uid}`, revoked });
	} catch(error) {
		next(error);
	}
});

module.exports = router;

/*
	verify public ssh key
*/
// router.post('/verifykey', async function(req, res){
// 	let key = req.body.key;

// 	try{
// 		return res.json({
// 			info: await Users.verifyKey(key)
// 		});
// 	}catch(error){
// 		return res.status(400).json({
// 			message: 'Key is not a public key file!'
// 		});
// 	}
	
// });