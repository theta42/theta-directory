'use strict';

// Self-service API token (PAT) management. Every endpoint is owner-scoped: a
// user only sees / mutates tokens where created_by === req.user.uid. No admin
// group is required (unlike routes/oauth_client.js); the Bearer-authed requests
// these tokens enable carry the creator's own LDAP group permissions.

const router = require('express').Router();
const { ApiToken } = require('../models/api_token');

function forbidden() {
	const e = new Error('Forbidden');
	e.name = 'Forbidden';
	e.message = 'You do not own this API token.';
	e.status = 403;
	return e;
}

// Resolve a token the caller owns. Missing or not-yours both raise 403 (no
// existence leak across users; ids are unguessable random hex anyway).
async function getOwned(req, id) {
	let token;
	try {
		token = await ApiToken.get(id);
	} catch (e) {
		throw forbidden();
	}
	if (!token || token.created_by !== req.user.uid) throw forbidden();
	return token;
}

// Accept `expires_in_days` from the UI and resolve it to an epoch-ms
// `expires_at` (0 = never). Mutates `body` in place.
function resolveExpiry(body) {
	if (body.expires_in_days !== undefined && body.expires_in_days !== '') {
		const days = Number(body.expires_in_days);
		body.expires_at = days > 0 ? (new Date).getTime() + days * 86400000 : 0;
		delete body.expires_in_days;
	} else if (body.expires_in_days !== undefined) {
		body.expires_at = 0;
		delete body.expires_in_days;
	}
	return body;
}

router.get('/', async function(req, res, next) {
	try {
		return res.json({ results: await ApiToken.listDetail({ created_by: req.user.uid }) });
	} catch (error) {
		next(error);
	}
});

router.post('/', async function(req, res, next) {
	try {
		req.body.created_by = req.user.uid;
		resolveExpiry(req.body);

		const token = await ApiToken.add(req.body);

		return res.json({
			results: token,
			token: token._raw_token,
			message: `API token '${token.name}' created. Save it now — it will not be shown again.`,
		});
	} catch (error) {
		next(error);
	}
});

router.get('/:id', async function(req, res, next) {
	try {
		return res.json({ results: await getOwned(req, req.params.id) });
	} catch (error) {
		next(error);
	}
});

router.put('/:id', async function(req, res, next) {
	try {
		const token = await getOwned(req, req.params.id);

		const update = {};
		for (const k of ['name', 'description']) {
			if (req.body[k] !== undefined) update[k] = req.body[k];
		}
		// Allow extending/shortening the lifetime. Accept expires_in_days (UI)
		// or expires_at (epoch ms); 0 / '' / missing means "no expiry".
		if (req.body.expires_in_days !== undefined && req.body.expires_in_days !== '') {
			const days = Number(req.body.expires_in_days);
			update.expires_at = days > 0 ? (new Date).getTime() + days * 86400000 : 0;
		} else if (req.body.expires_at !== undefined) {
			update.expires_at = Number(req.body.expires_at) || 0;
		}

		return res.json({
			results: await token.update(update),
			message: `API token '${token.name}' updated.`,
		});
	} catch (error) {
		next(error);
	}
});

router.delete('/:id', async function(req, res, next) {
	try {
		const token = await getOwned(req, req.params.id);
		await token.remove();

		return res.json({
			id: req.params.id,
			message: `API token '${token.name}' revoked.`,
		});
	} catch (error) {
		next(error);
	}
});

router.post('/:id/rotate', async function(req, res, next) {
	try {
		const token = await getOwned(req, req.params.id);
		const raw = await token.rotate();

		return res.json({
			token: raw,
			message: `API token '${token.name}' rotated. Save it — it will not be shown again.`,
		});
	} catch (error) {
		next(error);
	}
});

module.exports = router;