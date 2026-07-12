'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
var express = require('express');
var router = express.Router();
const moment = require('moment');
const {marked} = require('marked');
const {InviteToken, PasswordResetToken} = require('./../models/token');
const conf = require('@simpleworkjs/conf');

const tosHtml = marked(fs.readFileSync(path.join(__dirname, '../../tos.md'), 'utf8'));
const { version: buildVersion } = require('../package.json');
let buildHash = 'unknown';
try { buildHash = execSync('git rev-parse --short HEAD', { cwd: __dirname }).toString().trim(); } catch(_) {}

const values ={
  title: conf.environment !== 'production' ? `dev` : '',
  titleIcon: conf.environment !== 'production' ? `<i class="fa-brands fa-dev"></i>` : '',
  name: conf.name,
  buildVersion,
  buildHash,
  buildYear: new Date().getFullYear(),
}

// List of front end node modules to be served
const frontEndModules = ['bootstrap', 'mustache', 'jquery', '@fortawesome',
  'moment', '@popper', 'jq-repeat',
];

// Server front end modules
// https://stackoverflow.com/a/55700773/3140931
frontEndModules.forEach(dep => {
  router.use(`/static-modules/${dep}`, express.static(path.join(__dirname, `../node_modules/${dep}`)))
});

// Have express server static content( images, CSS, browser JS) from the public
// local folder.
router.use('/static', express.static(path.join(__dirname, '../public')))

// Public health endpoint for container/orchestration healthchecks.
// Mounted at / (no auth) in app.js, so this is intentionally unauthenticated.
router.get('/health', function(req, res) {
  res.json({ status: 'ok' });
});

router.get('/tos', function(req, res) {
  res.render('tos', {...values, tosHtml});
});

router.get('/admin', function(req, res) {
  res.render('admin', {...values});
});

router.get('/notifications', function(req, res) {
  res.render('notifications', {...values});
});

router.get('/invites', function(req, res) {
  res.render('invites', {...values});
});

router.get('/onboarding', function(req, res) {
  res.render('onboarding', {...values, tosHtml});
});

router.get('/', async function(req, res, next) {
  res.render('profile', {...values});
});

router.get('/users', async function(req, res, next) {
  res.render('users', {...values});
});

router.get('/login', async function(req, res, next) {
  res.render('login', {...values, redirect: req.query.redirect});
});

router.get('/oauth-clients', function(req, res, next) {
  const issuer = ((conf.oauth && conf.oauth.issuer) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.render('oauth_clients', {...values, issuer, discoveryUrl: `${issuer}/.well-known/openid-configuration`});
});

router.get('/api-tokens', function(req, res, next) {
  res.render('api_tokens', {...values});
});



router.get('/users/:uid', function(req, res, next) {
  res.render('profile', {...values});
});

router.get('/groups', function(req, res, next) {
  res.render('groups', {...values});
});

router.get('/token', function(req, res, next) {
  res.render('token', {...values});
});

            
router.get('/login/resetpassword/:token', async function(req, res, next){
	let token = await PasswordResetToken.get(req.params.token);

	if(token.is_valid && 86400000+Number(token.created_on) > (new Date).getTime()){
		res.render('reset_password', {token:token, ...values });
	}else{
		next({message: 'token not found', status: 404});
	}
});

router.get('/login/invite/:token/:mailToken', async function(req, res, next){
	try{
		
		let token = await InviteToken.get(req.params.token); 
		if(token.is_valid && token.mail !== '__NONE__' && token.mail_token === req.params.mailToken){
			token.created_on = moment(token.created_on, 'x').fromNow();
  			res.render('invite', {invite: token, ...values});
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
  			res.render('invite_email', {invite: token, ...values});
		}else{
			next({message: 'token not found', status: 404});
		}
	}catch(error){
		next(error);
	}
});


router.get('/login/*splat', async function(req, res, next) {
  res.render('login', {...values, redirect: req.query.redirect});
});

module.exports = router;
