'use strict';

// Authorization for model events pushed over the socket.
//
// The bridge this replaces fanned every event out to every authenticated
// socket, and separately let any client publish a topic for the server to
// rebroadcast. These tests pin the two properties that keep that from
// recurring: nothing is broadcast without a gate, and publishing is confined to
// exactly the models that have one.

jest.mock('../utils/permission', () => ({
	// Mirrors the real helper: god_admin (or the legacy alias) is a global admin.
	isSuperAdmin: async (cns) => cns.includes('god_admin') || cns.includes('app_super_admin'),
}));

const {READERS, LIVE_MODELS, parseTopic, ormBus} = require('../utils/socket_pubsub');

const ctx = (cns) => ({user: {dn: 'uid=x,ou=people,dc=test,dc=local'}, memberOfCns: cns, isSuperAdmin: cns.includes('god_admin')});

describe('parseTopic', () => {
	test('splits a model event', () => {
		expect(parseTopic('model:Resource:update:abc')).toEqual({model: 'Resource', action: 'update', pk: 'abc'});
	});

	test('the ORM dialect carries no pk in the topic', () => {
		expect(parseTopic('model:Resource:create')).toEqual({model: 'Resource', action: 'create', pk: undefined});
	});

	test('a pk containing colons is rejoined, not truncated', () => {
		// LDAP DNs and composite keys both contain ':' or ','.
		expect(parseTopic('model:Resource:update:cn=a,dc=x:dc=y').pk).toBe('cn=a,dc=x:dc=y');
	});

	test('non-model topics are rejected', () => {
		expect(parseTopic('not:a:model')).toBeNull();
		expect(parseTopic('')).toBeNull();
		expect(parseTopic(undefined)).toBeNull();
	});
});

describe('read gates', () => {
	test('directory admins may read Resource, ResourceGroup and PluginInstance', () => {
		for (const group of ['app_sso_directory_admin', 'app_sso_admin']) {
			expect(READERS.Resource(ctx([group]))).toBe(true);
			expect(READERS.ResourceGroup(ctx([group]))).toBe(true);
			expect(READERS.PluginInstance(ctx([group]))).toBe(true);
		}
	});

	test('a global super admin may read them', () => {
		expect(READERS.Resource(ctx(['god_admin']))).toBe(true);
	});

	test('an ordinary user may read none of them', () => {
		// The whole point: before this gate, any authenticated socket received
		// every Resource payload in the directory.
		const plain = ctx(['some-team']);
		expect(READERS.Resource(plain)).toBe(false);
		expect(READERS.ResourceGroup(plain)).toBe(false);
		expect(READERS.PluginInstance(plain)).toBe(false);
	});

	test('a user whose group membership could not be resolved reads nothing', () => {
		// contextFor() falls back to an empty list rather than guessing.
		expect(READERS.Resource(ctx([]))).toBe(false);
	});
});

describe('models without a gate', () => {
	test('token models are absent, so their events are never broadcast', () => {
		// These are written on every login and password reset and must never
		// reach a browser.
		for (const model of ['AuthToken', 'OtpToken', 'PasswordResetToken', 'Token', 'ServiceToken']) {
			expect(READERS[model]).toBeUndefined();
		}
	});

	test('secret-bearing models are absent', () => {
		for (const model of ['SharedSecret', 'VaultAppToken', 'AgentJoinKey', 'SiteJoinKey']) {
			expect(READERS[model]).toBeUndefined();
		}
	});
});

describe('ormBus', () => {
	test('forwards only models that have a gate', () => {
		const published = [];
		const bus = ormBus({publish: (t, d) => published.push(t), subscribe: () => {}});

		bus.publish('model:Resource:create', {model: 'Resource', action: 'create', pk: '1'});
		bus.publish('model:PluginInstance:update', {model: 'PluginInstance', action: 'update', pk: '2'});
		// The ORM publishes for every model it loads, including these.
		bus.publish('model:AuthToken:create', {model: 'AuthToken', action: 'create', pk: '3'});
		bus.publish('model:OtpToken:create', {model: 'OtpToken', action: 'create', pk: '4'});

		expect(published).toEqual(['model:Resource:create', 'model:PluginInstance:update']);
	});

	test('a payload with no model is dropped rather than thrown on', () => {
		const published = [];
		const bus = ormBus({publish: (t) => published.push(t), subscribe: () => {}});
		expect(() => bus.publish('model:Weird:create', null)).not.toThrow();
		expect(published).toEqual([]);
	});

	test('LIVE_MODELS is derived from READERS, so the two cannot drift', () => {
		// Publishing something ungated would leak; gating something that never
		// publishes would be dead code.
		expect([...LIVE_MODELS].sort()).toEqual(Object.keys(READERS).sort());
	});
});
