'use strict';

const router = require('express').Router();
const { OAuthClient } = require('../models/oauth_client');
const permission = require('../utils/permission');

const ADMIN_GROUP = 'app_sso_oauth_admin';

router.get('/', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);
		return res.json({ results: await OAuthClient.listDetail() });
	} catch(error) {
		next(error);
	}
});

router.post('/', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);

		req.body.created_by = req.user.uid;

		// Parse redirect_uris if sent as newline-separated string from the form
		if (typeof req.body.redirect_uris === 'string') {
			req.body.redirect_uris = req.body.redirect_uris.split('\n').map(s => s.trim()).filter(Boolean);
		}
		// Parse scopes if sent as space-separated string
		if (typeof req.body.scopes === 'string') {
			req.body.scopes = req.body.scopes.split(' ').map(s => s.trim()).filter(Boolean);
		}
		// jQuery serializeObject sends nested fields as "token_lifetime[access_token]"
		if (req.body['token_lifetime[access_token]'] || req.body['token_lifetime[refresh_token]']) {
			req.body.token_lifetime = {
				access_token: Number(req.body['token_lifetime[access_token]']) || 3600,
				refresh_token: Number(req.body['token_lifetime[refresh_token]']) || 2592000,
			};
			delete req.body['token_lifetime[access_token]'];
			delete req.body['token_lifetime[refresh_token]'];
		}

		const client = await OAuthClient.add(req.body);

		return res.json({
			results: client,
			client_secret: client._raw_secret,
			message: `OAuth client '${client.name}' created. Save the client secret — it will not be shown again.`,
		});
	} catch(error) {
		next(error);
	}
});

router.get('/:client_id', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);
		return res.json({ results: await OAuthClient.get(req.params.client_id) });
	} catch(error) {
		next(error);
	}
});

router.put('/:client_id', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);

		const client = await OAuthClient.get(req.params.client_id);

		if (typeof req.body.redirect_uris === 'string') {
			req.body.redirect_uris = req.body.redirect_uris.split('\n').map(s => s.trim()).filter(Boolean);
		}
		if (typeof req.body.scopes === 'string') {
			req.body.scopes = req.body.scopes.split(' ').map(s => s.trim()).filter(Boolean);
		}

		return res.json({
			results: await client.update(req.body),
			message: `OAuth client '${client.name}' updated.`,
		});
	} catch(error) {
		next(error);
	}
});

router.delete('/:client_id', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);

		const client = await OAuthClient.get(req.params.client_id);
		await client.remove();

		return res.json({
			client_id: req.params.client_id,
			message: `OAuth client '${client.name}' deleted.`,
		});
	} catch(error) {
		next(error);
	}
});

router.post('/:client_id/rotate', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);

		const client = await OAuthClient.get(req.params.client_id);
		const new_secret = await client.rotateSecret();

		return res.json({
			client_secret: new_secret,
			message: `Client secret rotated for '${client.name}'. Save it — it will not be shown again.`,
		});
	} catch(error) {
		next(error);
	}
});

module.exports = router;
