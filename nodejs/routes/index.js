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
const { mountStaticModules } = require('@simpleworkjs/app-stack');

const values ={
  title: conf.environment !== 'production' ? `dev` : '',
  titleIcon: conf.environment !== 'production' ? `<i class="fa-brands fa-dev"></i>` : '',
  name: conf.name,
  logo: conf.logo,
  // Connection conventions the catalog needs to render "how to reach this"
  // (conf/base.js `directory`). Safe to expose: a jump-host name and a default
  // port are public connection info, not credentials.
  directoryConf: {
    jumpHost: (conf.directory && conf.directory.jumpHost) || '',
    defaultSshPort: (conf.directory && conf.directory.defaultSshPort) || 22,
  },
  ...buildInfo,
}

// List of front end node modules to be served
// Vendor libraries only change when package versions are bumped (a rebuild),
// so they're safe to cache aggressively; ETag/Last-Modified (on by default)
// still cover that rare case with a cheap 304 instead of a stale asset. The
// app's own JS/CSS/img from public/ gets a shorter maxAge since it changes on
// every deploy and isn't cache-busted/fingerprinted.
mountStaticModules(router, {
  root: path.join(__dirname, '..'),
  deps: ['bootstrap', 'mustache', 'jquery', '@fortawesome', 'moment', '@popper', 'jq-repeat', '@simpleworkjs/frontend'],
});

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
router.get('/overview', function(req, res) {
  res.render('overview', {...values});
});

// Connected theta-agent hosts + live telemetry (admin). Data from
// GET /api/agent/nodes; live updates via socket.io 'agent.*' events.
router.get('/agents', function(req, res) {
  res.render('agents', {...values});
});

router.get('/admin', (req, res) => res.redirect(301, '/overview'));
router.get('/notifications', (req, res) => res.redirect(301, '/overview'));
router.get('/dashboard', (req, res) => res.redirect(301, '/overview'));
router.get('/executive', (req, res) => res.redirect(301, '/overview'));

router.get('/conf', function(req, res) {
  // Admin-only Configuration page. The view renders the shell for anyone
  // (like /users, /directory, etc.); the client gates access with
  // app.auth.forceLogin(['admin','app_sso_admin']) and the /api/conf endpoint
  // enforces app_sso_admin server-side. The previous server-side
  // permission.byGroup(req.user,…) 401'd on a browser navigation because this
  // app's auth-token is a header set by client JS (localStorage), not a
  // cookie — so req.user is undefined on a plain page load.
  res.render('conf', {...values});
});

router.get('/directory', function(req, res) {
  res.render('directory', {...values});
});

router.get('/discovery', function(req, res, next) {
  res.redirect('/directory');
});

router.get('/plugins', function(req, res, next) {
  res.redirect('/directory');
});

router.get('/vault', function(req, res) {
  // Personal per-user secrets (secret/users/<uid>/*) for everyone; admins get
  // free-form access across all of secret/ plus an Apps tab to mint scoped
  // tokens for external apps. The view renders the shell for any logged-in
  // user; the client gates login via app.auth.forceLogin() and derives the
  // admin/namespace scope from /api/user/me. The /api/vault proxy enforces the
  // same scoping server-side (scopeGuard + the token's own OpenBao policy), so
  // the client-derived scope is only cosmetic. vaultAddr is the only
  // server-rendered value (it's a non-user-specific env var); uid + isAdmin
  // are resolved client-side to avoid the header-vs-navigation auth mismatch.
  res.render('vault', {
    ...values,
    vaultAddr: process.env.VAULT_ADDR || 'http://openbao:8200',
  });
});

// Linkable deep-link to a single resource's modal, e.g. from the resource
// modal's app.modal `url` option. Mirrors /users/:uid below: no server-side
// use of :slug at all -- the client reads location.pathname itself and opens
// the matching resource's modal once the page's own data has loaded.
router.get('/directory/:slug', function(req, res) {
  res.render('directory', {...values});
});

// Route removed since it's now in directory

router.get('/onboarding', async function(req, res, next) {
  try {
    const tos = await Tos.getCurrent();
    res.render('onboarding', {...values, tosHtml: xss(marked(tos.content))});
  } catch (error) {
    next(error);
  }
});

router.get('/', async function(req, res, next) {
  res.render('landing', {...values});
});

router.get('/profile', async function(req, res, next) {
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
