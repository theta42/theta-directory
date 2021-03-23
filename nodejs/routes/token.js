'use strict';

const router = require('express').Router();
const {AuthToken} = require('../models/auth');
var tokens = require('../models/token');
// const {Token, InviteToken, PasswordResetToken} = require('../models/token');

delete tokens.Token;

// const tokens  = {
// 	auth: AuthToken,
// 	invite: InviteToken,
// 	password: PasswordResetToken,
// }

router.get('/', async function(req, res, next){
	try{
		return res.json({results: Object.keys(tokens)})
	}catch(error){
		throw(error);
	}
});

router.get('/:name', async function(req, res, next){
	try{
		console.log(tokens, req.params.name)

		return res.json({
			results:  await tokens[req.params.name][req.query.detail ? "listDetail" : "list"]()
		});
	}catch(error){
		next(error);
	}
});


router.get('/:name/:token', async function(req, res, next){
	try{
		return res.json({
			results:  await tokens[req.params.name].get(req.params.token)
		});
	}catch(error){
		next(error);
	}
});

// router.delete('/:username', async function(req, res, next){
// 	try{
// 		let user = await User.get(req.params.username);

// 		return res.json({username: req.params.username, results: await user.remove()})
// 	}catch(error){
// 		next(error);
// 	}
// });

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