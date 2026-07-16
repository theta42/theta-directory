'use strict';

const router = require('express').Router();
const {Tos} = require('../models/tos');
const {UserVerification} = require('../models/verification');
const permission = require('../utils/permission');

// Any authenticated user may read the current ToS (it's what they already
// see on /tos and during onboarding, and it isn't sensitive) -- only saving
// an edit is admin-gated.
router.get('/', async function(req, res, next) {
	try {
		const tos = await Tos.getCurrent();
		return res.json(tos);
	} catch (error) {
		next(error);
	}
});

router.put('/', async function(req, res, next) {
	try {
		await permission.byGroup(req.user, ['app_sso_admin']);

		const {content, resetAcceptance} = req.body;
		if (!content || !content.trim()) {
			return res.status(400).json({name: 'ValidationError', message: 'content is required'});
		}

		const tos = await Tos.getCurrent();
		await tos.update({content, updated_by: req.user.uid, updated_on: Date.now()});

		// Opt-in: a substantive change may need everyone to agree again, but a
		// wording/typo fix shouldn't re-prompt every user, so this only runs
		// when the admin explicitly asks for it.
		let resetCount = 0;
		if (resetAcceptance) {
			const verifications = await UserVerification.listDetail();
			for (const v of verifications) {
				if (v.tos_accepted) {
					// Leave tos_accepted_at as the last acceptance time (a
					// historical fact) -- only the boolean flips, driving
					// onboardingNeeds back to including 'tos'.
					await v.update({tos_accepted: false});
					resetCount++;
				}
			}
		}

		return res.json({results: tos, resetCount});
	} catch (error) {
		next(error);
	}
});

module.exports = router;
