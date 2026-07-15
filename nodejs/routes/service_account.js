'use strict';

const router = require('express').Router();
const {ServiceAccount} = require('../models/service_account');
const permission = require('../utils/permission');

const ADMIN_GROUP = 'app_sso_admin';

router.get('/', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);
		return res.json({results: await ServiceAccount.list()});
	} catch(error) {
		next(error);
	}
});

router.post('/', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);
		const result = await ServiceAccount.create({cn: req.body.cn, description: req.body.description});
		return res.json({
			results: result,
			message: `Service account "${result.cn}" created. Save the password now — it will not be shown again.`,
		});
	} catch(error) {
		next(error);
	}
});

router.put('/:cn/password', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);
		const result = await ServiceAccount.setPassword(req.params.cn, req.body.password);
		return res.json({
			results: result,
			message: `Password rotated for "${req.params.cn}". Save it now — it will not be shown again.`,
		});
	} catch(error) {
		next(error);
	}
});

router.delete('/:cn', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, [ADMIN_GROUP]);
		await ServiceAccount.remove(req.params.cn);
		return res.json({message: `Service account "${req.params.cn}" deleted.`});
	} catch(error) {
		next(error);
	}
});

module.exports = router;
