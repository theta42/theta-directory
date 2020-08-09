'use strict';

const router = require('express').Router();
const {User} = require('../models/user');
const {Auth, AuthToken} = require('../models/auth');
const {PasswordResetToken} = require('../models/token');


router.post('/login', async function(req, res, next){
	try{
		let auth = await Auth.login(req.body);
		return res.json({
			login: true,
			token: auth.token.token,
			message:`${req.body.uid} logged in!`,
		});
	}catch(error){
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

router.post('/resetpassword', async function(req, res, next){
	try{
		let sent = await User.passwordReset(`${req.protocol}://${req.hostname}`, req.body.mail);

		console.info('resetpassword for', req.body.mail, 'sent')

		return res.json({
			message: 'If the emaill address is in our system, you will receive a message.'
		});
	}catch(error){
		next(error);
	}
});

router.post('/resetpassword/:token', async function(req, res, next){
	try{
		let token = await PasswordResetToken.get(req.params.token);

		if(token.is_valid && 86400000+Number(token.created_on) > (new Date).getTime()){
			let user = await User.get(token.created_by);
			await user.setPassword(req.body);
			token.update({is_valid: false});
			return res.json({
				message: 'Password has been changed.'
			});
		}
	}catch(error){
		next(error);
	}
});

router.post('/invite/:token/:mailToken', async function(req, res, next) {
	try{
		req.body.token = req.params.token;
		req.body.mailToken = req.params.mailToken;
		let user = await User.addByInvite(req.body);
		let token = await AuthToken.add(user);

		return res.json({
			user: user.uid,
			token: token.token
		});

	}catch(error){
		next(error);
	}

});

router.post('/invite/:token', async function(req, res, next){
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