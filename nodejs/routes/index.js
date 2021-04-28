'use strict';

var express = require('express');
var router = express.Router();
const moment = require('moment');
const {InviteToken, PasswordResetToken} = require('./../models/token');
const conf = require('../conf/conf.js');


router.get('/', async function(req, res, next) {
  res.render('home', { title: 'Express', name: conf.name });
});

router.get('/login', function(req, res, next) {
  res.render('login', {redirect: req.query.redirect, name: conf.name });
});

router.get('/users', function(req, res, next) {
  res.render('users', { title: 'Express', name: conf.name });
});

router.get('/users/:uid', function(req, res, next) {
  res.render('home', { title: 'Express', name: conf.name });
});

router.get('/groups', function(req, res, next) {
  res.render('groups', { title: 'Express', name: conf.name });
});

router.get('/token', function(req, res, next) {
  res.render('token', { title: 'Express', name: conf.name });
});

            
router.get('/login/resetpassword/:token', async function(req, res, next){
	let token = await PasswordResetToken.get(req.params.token);

	if(token.is_valid && 86400000+Number(token.created_on) > (new Date).getTime()){
		res.render('reset_password', {token:token, name: conf.name });
	}else{
		next({message: 'token not found', status: 404});
	}
});

router.get('/login/invite/:token/:mailToken', async function(req, res, next){
	try{
		
		let token = await InviteToken.get(req.params.token); 
		if(token.is_valid && token.mail !== '__NONE__' && token.mail_token === req.params.mailToken){
			token.created_on = moment(token.created_on, 'x').fromNow();
  			res.render('invite', { title: 'Express', invite: token, name: conf.name  });
		}else{
			next({message: 'token not found', status: 404});
		}
	}catch(error){
		next(error);
	}
});

router.get('/login/invite/:token', async function(req, res, next){
	try{
		let token = await InviteToken.get(req.params.token);
		token.created_on = moment(token.created_on, 'x').fromNow();

		if(token.is_valid){
  			res.render('invite_email', { title: 'Express', invite: token, name: conf.name  });
		}else{
			next({message: 'token not found', status: 404});
		}
	}catch(error){
		next(error);
	}
});

module.exports = router;
