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

const {READERS, LIVE_MODELS, parseTopic, liveBus} = require('../utils/socket_pubsub');

const ctx = (cns, uid) => ({
	user: {dn: 'uid=' + (uid || 'x') + ',ou=people,dc=test,dc=local', uid: uid || 'x'},
	memberOfCns: cns,
	isSuperAdmin: cns.includes('god_admin'),
});

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

describe('liveBus', () => {
	test('forwards only models that have a gate', () => {
		const published = [];
		const bus = liveBus({publish: (t, d) => published.push(t), subscribe: () => {}});

		bus.publish('model:Resource:create', {model: 'Resource', action: 'create', pk: '1'});
		bus.publish('model:PluginInstance:update', {model: 'PluginInstance', action: 'update', pk: '2'});
		// The ORM publishes for every model it loads, including these.
		bus.publish('model:AuthToken:create', {model: 'AuthToken', action: 'create', pk: '3'});
		bus.publish('model:OtpToken:create', {model: 'OtpToken', action: 'create', pk: '4'});

		expect(published).toEqual(['model:Resource:create', 'model:PluginInstance:update']);
	});

	test('a payload with no model is dropped rather than thrown on', () => {
		const published = [];
		const bus = liveBus({publish: (t) => published.push(t), subscribe: () => {}});
		expect(() => bus.publish('model:Weird:create', null)).not.toThrow();
		expect(published).toEqual([]);
	});

	test('LIVE_MODELS is derived from READERS, so the two cannot drift', () => {
		// Publishing something ungated would leak; gating something that never
		// publishes would be dead code.
		expect([...LIVE_MODELS].sort()).toEqual(Object.keys(READERS).sort());
	});
});

describe('row-scoped gates', () => {
	// Being allowed to read *a* model is not the same as being allowed every
	// record of it. These four are per-row.
	test('a user sees their own User record and nobody else\'s', () => {
		const alice = ctx(['staff'], 'alice');
		expect(READERS.User(alice, {uid: 'alice'})).toBe(true);
		expect(READERS.User(alice, {uid: 'bob'})).toBe(false);
	});

	test('an admin sees every User record', () => {
		expect(READERS.User(ctx(['app_sso_admin'], 'root'), {uid: 'bob'})).toBe(true);
	});

	test('the User gate falls back to the topic pk when there is no body', () => {
		// Deletes carry no record.
		expect(READERS.User(ctx(['staff'], 'alice'), null, 'alice')).toBe(true);
		expect(READERS.User(ctx(['staff'], 'alice'), null, 'bob')).toBe(false);
	});

	test('notifications, PATs, mesh clients and access requests are owner-scoped', () => {
		const alice = ctx(['staff'], 'alice');
		expect(READERS.Notification(alice, {uid: 'alice'})).toBe(true);
		expect(READERS.Notification(alice, {uid: 'bob'})).toBe(false);
		expect(READERS.ApiToken(alice, {created_by: 'alice'})).toBe(true);
		expect(READERS.ApiToken(alice, {created_by: 'bob'})).toBe(false);
		expect(READERS.MeshClient(alice, {uid: 'alice'})).toBe(true);
		expect(READERS.MeshClient(alice, {uid: 'bob'})).toBe(false);
		expect(READERS.AccessRequest(alice, {uid: 'alice'})).toBe(true);
		expect(READERS.AccessRequest(alice, {uid: 'bob'})).toBe(false);
	});

	test('an unidentifiable record is withheld rather than shared', () => {
		const alice = ctx(['staff'], 'alice');
		expect(READERS.User(alice, {}, undefined)).toBe(false);
		expect(READERS.Notification(alice, {}, undefined)).toBe(false);
		expect(READERS.ApiToken(alice, {}, undefined)).toBe(false);
	});

	test('a PAT is never visible to an admin who does not own it', () => {
		// Deliberately no admin bypass: a personal access token is nobody
		// else's business, and the REST route is owner-scoped with no admin path.
		expect(READERS.ApiToken(ctx(['app_sso_admin', 'god_admin'], 'root'), {created_by: 'alice'})).toBe(false);
	});

	test('Group mirrors its ungated REST route', () => {
		// routes/group.js:8 has no authz guard. Mirrored on purpose; see the
		// comment on the gate. Tightening the route tightens this automatically.
		expect(READERS.Group(ctx([], 'anyone'))).toBe(true);
	});
});

describe('User payloads never carry credentials', () => {
	// userPassword is on a record read with attributes ['*','+'] as the admin
	// bind. It survives to the wire only because user_parse() sets it to
	// `undefined` inside a conditional — incidental, so user_ldap's announce()
	// strips it explicitly. This pins that.
	const {emit, bind} = require('../utils/model_events');

	test('the emitter forwards what it is given, so stripping must happen upstream', () => {
		const sent = [];
		bind({publish: (t, d) => sent.push(d)});
		emit('User', 'update', 'alice', {uid: 'alice', userPassword: '{SSHA512}deadbeef'});
		// The emitter is deliberately dumb; this documents that it does NOT
		// sanitize, which is why announce() must.
		expect(sent[0].data.userPassword).toBe('{SSHA512}deadbeef');
		bind(null);
	});

	test('a record with no toJSON is passed through as-is', () => {
		const sent = [];
		bind({publish: (t, d) => sent.push(d)});
		emit('Group', 'update', 'cn1', {cn: 'cn1', member: ['a']});
		expect(sent[0]).toEqual({model: 'Group', action: 'update', pk: 'cn1', data: {cn: 'cn1', member: ['a']}});
		bind(null);
	});

	test('toJSON is honoured when present, so isPrivate fields are dropped', () => {
		const sent = [];
		bind({publish: (t, d) => sent.push(d)});
		emit('DnsProvider', 'update', 'p1', {name: 'p1', token: 'SECRET', toJSON(){ return {name: this.name}; }});
		expect(sent[0].data).toEqual({name: 'p1'});
		expect(JSON.stringify(sent[0])).not.toContain('SECRET');
		bind(null);
	});

	test('a delete carries no body', () => {
		const sent = [];
		bind({publish: (t, d) => sent.push(d)});
		emit('Group', 'delete', 'cn1', {cn: 'cn1', member: ['a']});
		expect(sent[0].data).toBeNull();
		bind(null);
	});
});

describe('non-model channels (agent pushes)', () => {
	const {CHANNELS} = require('../utils/socket_pubsub');

	test('agent channels are admin-gated, mirroring routes/api_agent.js', () => {
		for (const ch of ['agent.telemetry', 'agent.discovery', 'agent.response']) {
			expect(typeof CHANNELS[ch]).toBe('function');
			expect(CHANNELS[ch](ctx(['app_sso_admin']))).toBe(true);
			expect(CHANNELS[ch](ctx(['app_sso_directory_admin']))).toBe(true);
			expect(CHANNELS[ch](ctx(['god_admin']))).toBe(true);
		}
	});

	test('an ordinary user receives no agent push', () => {
		// These were bare io.emit calls. agent.response carries the OUTPUT of
		// commands run on a host, on a channel that can run arbitrary bash, and
		// every logged-in user was receiving it.
		const plain = ctx(['some-team']);
		expect(CHANNELS['agent.telemetry'](plain)).toBe(false);
		expect(CHANNELS['agent.discovery'](plain)).toBe(false);
		expect(CHANNELS['agent.response'](plain)).toBe(false);
	});

	test('a user with unresolvable group membership receives nothing', () => {
		expect(CHANNELS['agent.response'](ctx([]))).toBe(false);
	});

	test('an unlisted channel has no gate, so emitChannel drops it', () => {
		expect(CHANNELS['agent.secret']).toBeUndefined();
		expect(CHANNELS['anything.else']).toBeUndefined();
	});
});

describe('emitChannel delivery', () => {
	const {emitChannel} = require('../utils/socket_pubsub');

	// A socket with its authz context pre-seeded, so the delivery loop is
	// exercised without reaching LDAP (contextFor honours the cache).
	function fakeSocket(name, cns) {
		return {
			id: name,
			user: {dn: 'uid=' + name + ',ou=people,dc=test,dc=local', uid: name},
			_authzCtx: {user: {uid: name}, memberOfCns: cns, isSuperAdmin: cns.includes('god_admin')},
			_authzCtxAt: Date.now(),
			sent: [],
			emit(ch, data) { this.sent.push([ch, data]); },
		};
	}

	function fakeIo(sockets) {
		return {sockets: {sockets: new Map(sockets.map((s) => [s.id, s]))}};
	}

	test('command output reaches the admin socket and not the ordinary one', async () => {
		const admin = fakeSocket('root', ['app_sso_admin']);
		const plain = fakeSocket('alice', ['some-team']);
		emitChannel(fakeIo([admin, plain]), 'agent.response', {agentId: 'a1', payload: {output: 'root:x:0:0'}});
		await new Promise((r) => setImmediate(r));

		expect(admin.sent).toHaveLength(1);
		expect(admin.sent[0][0]).toBe('agent.response');
		expect(plain.sent).toHaveLength(0);
		// The thing that used to go everywhere.
		expect(JSON.stringify(plain.sent)).not.toContain('root:x:0:0');
	});

	test('an ungated channel is delivered to nobody', async () => {
		const admin = fakeSocket('root', ['god_admin']);
		emitChannel(fakeIo([admin]), 'agent.somethingNew', {payload: 'x'});
		await new Promise((r) => setImmediate(r));
		expect(admin.sent).toHaveLength(0);
	});

	test('a socket with no user is skipped', async () => {
		const anon = {id: 'anon', user: null, sent: [], emit(c, d) { this.sent.push([c, d]); }};
		emitChannel(fakeIo([anon]), 'agent.telemetry', {payload: 'x'});
		await new Promise((r) => setImmediate(r));
		expect(anon.sent).toHaveLength(0);
	});

	test('a missing io is a no-op rather than a throw', () => {
		expect(() => emitChannel(null, 'agent.telemetry', {})).not.toThrow();
	});
});

describe('withEvents on model-redis Tables', () => {
	const {withEvents, bind} = require('../utils/model_events');

	function makeTable() {
		class Fake {
			static _key = 'id';
			constructor(d) { Object.assign(this, d); }
			static async create(d) { return new Fake(d); }
			async update(d) { Object.assign(this, d); return this; }
			async remove() { return true; }
			// model-redis strips isPrivate fields here.
			toJSON() { const o = {...this}; delete o.secret_hash; return o; }
		}
		return Fake;
	}

	test('create, update and delete each announce once, with the record pk', async () => {
		const sent = [];
		bind({publish: (t, d) => sent.push([t, d.pk])});
		const T = withEvents(makeTable(), 'Thing');
		const inst = await T.create({id: 'abc', name: 'x'});
		await inst.update({name: 'y'});
		await inst.remove();
		bind(null);
		expect(sent).toEqual([
			['model:Thing:create', 'abc'],
			['model:Thing:update', 'abc'],
			['model:Thing:delete', 'abc'],
		]);
	});

	test('a delete announces the pk it had before removal', async () => {
		const sent = [];
		bind({publish: (t, d) => sent.push(d)});
		const T = withEvents(makeTable(), 'Thing');
		const inst = await T.create({id: 'gone'});
		sent.length = 0;
		await inst.remove();
		bind(null);
		expect(sent[0].pk).toBe('gone');
		expect(sent[0].data).toBeNull();
	});

	test('an isPrivate field never reaches the payload', async () => {
		// ApiToken.secret_hash is isPrivate; model-redis drops it in toJSON and
		// the emitter honours that. Checked on the serialized frame, since
		// `'k' in obj` is true even for undefined values.
		const sent = [];
		bind({publish: (t, d) => sent.push(d)});
		const T = withEvents(makeTable(), 'ApiToken');
		await T.create({id: 't1', created_by: 'alice', secret_hash: '$2b$10$SUPERSECRETHASH'});
		bind(null);
		expect(JSON.stringify(sent[0])).not.toContain('SUPERSECRETHASH');
		expect(sent[0].data.secret_hash).toBeUndefined();
		expect(sent[0].data.created_by).toBe('alice');
	});
});
