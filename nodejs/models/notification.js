'use strict';

const Table = require('.');
const UUID = function b(a){return a?(a^Math.random()*16>>a/4).toString(16):([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,b)};

class Notification extends Table {
	static _key = 'notification_id';
	static _keyMap = {
		notification_id: { default: UUID,            type: 'string' },
		created_by:      { isRequired: true,          type: 'string' },
		created_on:      { default: () => Date.now()                 },
		subject:         { isRequired: true,          type: 'string' },
		message:         { isRequired: true,          type: 'string' },
		filter_type:     { isRequired: true,          type: 'string' },
		filter_value:    { default: '',               type: 'string' },
		active_only:     { default: false,            type: 'boolean' },
		status:          { default: 'sending',        type: 'string' },
		sent_count:      { default: 0,                type: 'number' },
		failed_count:    { default: 0,                type: 'number' },
		sent_at:         { default: 0,                type: 'number' },
	};
}
Notification.register();

module.exports = { Notification };
