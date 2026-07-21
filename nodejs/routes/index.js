'use strict';

const path = require('path');
var express = require('express');
var router = express.Router();
const moment = require('moment');
const {marked} = require('marked');
const xss = require('xss');
const {InviteToken, PasswordResetToken} = require('./../models/token');
const {Tos} = require('../models/tos');
const conf = require('@simpleworkjs/conf');
const buildInfo = require('../utils/build_info');

const values ={
  title: conf.environment !== 'production' ? `dev` : '',
  titleIcon: conf.environment !== 'production' ? `<i class="fa-brands fa-dev"></i>` : '',
  name: conf.name,
  logo: conf.logo,
  ...buildInfo,
}

// List of front end node modules to be served
const frontEndModules = ['bootstrap', 'mustache', 'jquery', '@fortawesome',
  'moment', '@popper', 'jq-repeat',
];

// Server front end modules
// https://stackoverflow.com/a/55700773/3140931
// Vendor libraries only change when package versions are bumped (a rebuild),
// so they're safe to cache aggressively; ETag/Last-Modified (on by default)
// still cover that rare case with a cheap 304 instead of a stale asset.
frontEndModules.forEach(dep => {
  router.use(`/static-modules/${dep}`, express.static(path.join(__dirname, `../node_modules/${dep}`), {maxAge: '7d'}))
});

// Have express server static content( images, CSS, browser JS) from the public
// local folder. Shorter maxAge than /static-modules since this is the app's
// own JS/CSS, which changes on every deploy and isn't cache-busted/fingerprinted.
router.use('/static', express.static(path.join(__dirname, '../public'), {maxAge: '1h'}))

// Public health endpoint for container/orchestration healthchecks.
// Mounted at / (no auth) in app.js, so this is intentionally unauthenticated.
router.get('/health', function(req, res) {
  res.json({ status: 'ok' });
});

router.get('/tos', async function(req, res, next) {
  try {
    const tos = await Tos.getCurrent();
    res.render('tos', {...values, tosHtml: xss(marked(tos.content)), tosUpdatedOnFmt: moment(tos.updated_on, 'x').format('MMMM YYYY')});
  } catch (error) {
    next(error);
  }
});

// Admin dashboard (stats + recent/inactive users) and Notifications
// (broadcast + history) merged into one page.
router.get('/dashboard', function(req, res) {
  res.render('dashboard', {...values});
});

router.get('/admin', (req, res) => res.redirect(301, '/dashboard'));
router.get('/notifications', (req, res) => res.redirect(301, '/dashboard'));

router.get('/invites', function(req, res) {
  res.render('invites', {...values});
});

router.get('/onboarding', async function(req, res, next) {
  try {
    const tos = await Tos.getCurrent();
    res.render('onboarding', {...values, tosHtml: xss(marked(tos.content))});
  } catch (error) {
    next(error);
  }
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

// OAuth client management and LDAP connection info, merged into one page
// (tabs) -- both are "how do other apps/hosts plug into this SSO" concerns.
// LDAP values are derived from the running config + request host rather than
// hardcoded in a doc, so they're always right for *this* deployment.
router.get('/integrations', function(req, res, next) {
  const issuer = ((conf.oauth && conf.oauth.issuer) || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  // The public-facing host (from the OAuth issuer). Used for OIDC links.
  const issuerHost = issuer.replace(/^https?:\/\//, '').replace(/:\d+$/, '');

  // The hostname advertised for direct LDAPS binds may be a separate,
  // internal-only name so admins don't have to port-forward 636 publicly.
  // Defaults to the issuer host to preserve prior behavior.
  const ldapsHost = (conf.ldap && conf.ldap.ldapsHost) || issuerHost;
  const ldapsPort = Number((conf.ldap && conf.ldap.ldapsPort) || 636) || 636;

  const userBase = (conf.ldap && conf.ldap.userBase) || 'ou=people,dc=example,dc=com';
  const groupBase = (conf.ldap && conf.ldap.groupBase) || 'ou=groups,dc=example,dc=com';
  // The base DN isn't stored as its own config value -- derive it by
  // stripping the leading "ou=...," off userBase (ou=people,dc=example,dc=com
  // -> dc=example,dc=com).
  const baseDn = userBase.replace(/^ou=[^,]+,/i, '');

  res.render('integrations', {
    ...values,
    issuer,
    discoveryUrl: `${issuer}/.well-known/openid-configuration`,
    ldapHost: ldapsHost,
    ldapsUrl: `ldaps://${ldapsHost}:${ldapsPort}`,
    ldapsHostExplicit: !!(conf.ldap && conf.ldap.ldapsHost),
    baseDn,
    userBase,
    groupBase,
    userFilter: (conf.ldap && conf.ldap.userFilter) || '(objectClass=posixAccount)',
    userNameAttribute: (conf.ldap && conf.ldap.userNameAttribute) || 'uid',
    exampleBindDn: `cn=ldapclient,${userBase}`,
    ssoUrl: issuer,
  });
});
router.get('/oauth-clients', (req, res) => res.redirect(301, '/integrations'));
router.get('/ldap-info', (req, res) => res.redirect(301, '/integrations'));

// API Tokens is now a section on the Profile page (own profile only).
router.get('/api-tokens', (req, res) => res.redirect(301, '/'));



router.get('/users/:uid', function(req, res, next) {
  res.render('profile', {...values});
});

router.get('/groups', function(req, res, next) {
  res.render('groups', {...values});
});

router.get('/token', function(req, res, next) {
  res.render('token', {...values});
});

router.get('/sites', async function(req, res, next) {
  const net = require('net');
  const url = require('url');
  
  const myId = process.env.LDAP_SERVER_ID || 'Standalone';
  const hostsStr = process.env.LDAP_REPLICATION_HOSTS || '';
  const hosts = hostsStr.split(' ').filter(h => h);
  
  const sites = await Promise.all(hosts.map(hostUrl => {
      return new Promise((resolve) => {
          try {
              const u = new url.URL(hostUrl);
              const port = u.port || (u.protocol === 'ldaps:' ? 636 : 389);
              const hostname = u.hostname;
              const socket = new net.Socket();
              socket.setTimeout(2000);
              
              socket.on('connect', () => {
                  socket.destroy();
                  resolve({ url: hostUrl, status: 'Online' });
              });
              socket.on('timeout', () => {
                  socket.destroy();
                  resolve({ url: hostUrl, status: 'Offline (Timeout)' });
              });
              socket.on('error', (err) => {
                  socket.destroy();
                  resolve({ url: hostUrl, status: 'Offline (' + err.code + ')' });
              });
              socket.connect(port, hostname);
          } catch (e) {
              resolve({ url: hostUrl, status: 'Invalid URL' });
          }
      });
  }));
  
  res.render('sites', { ...values, myId, sites });
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
