'use strict';

const fs = require('fs');
const path = require('path');
const Table = require('.');

// Terms-of-Service text, editable by an admin at runtime (see routes/tos.js
// + the Dashboard's "Terms of Service" card) instead of being baked into the
// repo. A singleton row -- always keyed 'current' -- rather than a UUID like
// the other Redis models here, since there's only ever one live ToS.
class Tos extends Table {
	static _key = 'name';
	static _keyMap = {
		name:       {default: 'current', type: 'string'},
		content:    {isRequired: true,   type: 'string'},
		updated_by: {isRequired: true,   type: 'string'},
		updated_on: {default: () => Date.now()},
	};

	// Fetch the live row, seeding it from the bundled tos.md template the
	// first time this is ever called on a deployment (so upgrading an
	// existing install doesn't start with a blank ToS).
	static async getCurrent() {
		try {
			return await this.get('current');
		} catch (error) {
			const content = fs.readFileSync(path.join(__dirname, '../../tos.md'), 'utf8');
			return this.create({name: 'current', content, updated_by: 'system'});
		}
	}
}
Tos.register();

module.exports = {Tos};
