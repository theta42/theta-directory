const router = require('express').Router();
const permission = require('../utils/permission');
const dirBranding = require('../utils/dir_branding');

router.use(async (req, res, next) => {
	try {
		await permission.byGroup(req.user, ['app_sso_admin']);
		next();
	} catch(err) {
		next(err);
	}
});

router.get('/', async (req, res, next) => {
	try {
		const b = await dirBranding.getDirBranding();
		res.json({
			name: b.name || '',
			logo: b.logo || '',
			icon: b.icon || '',
		});
	} catch(err) {
		next(err);
	}
});

router.post('/', async (req, res, next) => {
	try {
		const body = req.body || {};
		const branding = {};
		for (const key of dirBranding.BRANDING_KEYS) {
			if (typeof body[key] === 'string') {
				branding[key] = body[key].trim();
			}
		}
		const saved = await dirBranding.setDirBranding(branding);
		res.json({ success: true, branding: saved });
	} catch(err) {
		next(err);
	}
});

module.exports = router;
