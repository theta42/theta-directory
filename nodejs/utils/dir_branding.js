'use strict';

// Directory-driven white-label branding.
//
// Branding (name, logo, icon) lives on the master Site resource's metadata:
//   metadata.branding = { name, logo, icon }
// It replicates to spokes naturally via the existing catalog export/import
// (importDirectory), so every site gets the same branding without any new
// replication mechanism.
//
// At boot, applyDirBranding() reads the local copy of the site resource and
// overlays its branding onto conf — same pattern as bao-conf. The UI reads and
// writes branding through the directory admin API (POST /api/conf/branding),
// keeping it in the catalog where it belongs (not secret, replicates freely).

const conf = require('@simpleworkjs/conf');
const { Resource } = require('../models/resource');

const BRANDING_KEYS = ['name', 'logo', 'icon'];

async function getCurrentSite() {
	const sites = await Resource.list({ where: { kind: 'site' } });
	return sites.find(s => s.metadata && s.metadata.isCurrentSite) || sites[0] || null;
}

async function getDirBranding() {
	const site = await getCurrentSite();
	const b = site && site.metadata && site.metadata.branding;
	if (!b || typeof b !== 'object') return {};
	return b;
}

async function applyDirBranding() {
	const b = await getDirBranding();
	for (const key of BRANDING_KEYS) {
		if (b[key] !== undefined && b[key] !== null && b[key] !== '') {
			conf[key] = b[key];
		}
	}
	return b;
}

async function setDirBranding(branding) {
	const site = await getCurrentSite();
	if (!site) throw new Error('no site resource found');

	const meta = { ...(site.metadata || {}) };
	meta.branding = {};
	for (const key of BRANDING_KEYS) {
		if (branding[key] !== undefined) {
			meta.branding[key] = branding[key];
		}
	}

	await site.update({ metadata: meta });

	for (const key of BRANDING_KEYS) {
		if (meta.branding[key] !== undefined && meta.branding[key] !== null && meta.branding[key] !== '') {
			conf[key] = meta.branding[key];
		} else if (meta.branding[key] === '' && conf[key]) {
			delete conf[key];
		}
	}

	return meta.branding;
}

module.exports = { getDirBranding, applyDirBranding, setDirBranding, BRANDING_KEYS };
