'use strict';

const {Group} = require('../models/group_ldap');
const groups = require('./groups');

// The global god-admin group (everything, everywhere). During migration the
// legacy `app_super_admin` is recognized as an alias (docs/GROUPS.md §10).
const SUPER_ADMIN_GROUP = groups.GOD_ADMIN;
const LEGACY_SUPER_ADMIN_ALIASES = ['app_super_admin'];

// True if the user (by resolved member cns) is a global god/super admin.
async function isSuperAdmin(memberOfCns) {
	return memberOfCns.includes(groups.GOD_ADMIN) ||
		memberOfCns.some((cn) => LEGACY_SUPER_ADMIN_ALIASES.includes(cn));
}

let byGroup = async function(user, checkGroups, ownerOf){
	// Membership is resolved once, transitively: a user placed in an admin group
	// through a nested group is as much a member as one listed on it directly.
	// Checking `group.member.includes(user.dn)` per group -- as this used to --
	// only ever sees the literal member list and would deny them.
	let memberOfCns = [];
	try{
		memberOfCns = await Group.list(user.dn);
	}catch(error){
		// Fall through to the per-group checks below rather than hard-failing;
		// they still catch direct membership if the resolver is unavailable.
	}

	if(await isSuperAdmin(memberOfCns)) return true;

	for(let group of checkGroups){
		if(memberOfCns.includes(group)) return true;
	}

	// `owner` is deliberately NOT transitive. It designates accountable people,
	// and inheriting ownership through a nested group would hand approval rights
	// to anyone transitively in it -- an escalation nobody asked for.
	for(let group of ownerOf || []){
		try{
			group = await Group.get(group);
			if(group.owner.includes(user.dn)) return true
		}catch(error){
			// group not found, continue checking
		}
	}

	let error = new Error('Insufficient Permission');
	error.name = 'Insufficient Permission';
	error.message = `You do not have permission to perform this action.`;
	error.status = 401;
	throw error;
}

// Resolve whether a user has `level` on a directory resource under the group
// model (see utils/groups.js). Applies the inheritance lattice and the
// `everyone`/`{site}_everyone` meta grants when the resource grants them.
//
//   user:    the auth user ({ dn, isMachine }).
//   resource:{ site, kind: 'host'|'app', slug }.
//   level:   'admin' | 'access' | an opaque capability token.
//   grantedGroups: optional array of the resource's granted group cns (used only
//     for meta `everyone` handling). Omit to skip meta grants.
async function onResource(user, resource, level, grantedGroups) {
	let memberOfCns = [];
	try { memberOfCns = await Group.list(user.dn); } catch (e) { /* ignore */ }

	if (await isSuperAdmin(memberOfCns)) return true;
	if (groups.hasPermission(memberOfCns, resource, level)) return true;

	// Meta grants: `everyone` / `{site}_everyone` confer access to any
	// authenticated (non-machine) user when the resource grants them.
	if (level === 'access' && !user.isMachine && Array.isArray(grantedGroups)) {
		const siteEveryone = groups.siteEveryoneCns(resource.site);
		if (grantedGroups.includes('everyone') || grantedGroups.includes(siteEveryone)) return true;
	}
	return false;
}

// Like onResource but throws Insufficient Permission when denied — for guards.
async function requireResource(user, resource, level, grantedGroups) {
	if (await onResource(user, resource, level, grantedGroups)) return;
	const error = new Error('Insufficient Permission');
	error.name = 'Insufficient Permission';
	error.status = 401;
	throw error;
}

module.exports = {
	byGroup,
	onResource,
	requireResource,
	isSuperAdmin,
	SUPER_ADMIN_GROUP,
	LEGACY_SUPER_ADMIN_ALIASES,
	...groups, // group schema builders (slugify, resourceGroupCns, ...)
};
