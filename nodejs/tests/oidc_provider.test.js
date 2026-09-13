'use strict';

// OIDC provider surfaces that need no LDAP login: discovery, the JWKS, public
// clients, and token revocation. Kept apart from tests/oauth.test.js
// deliberately — that suite logs a user in, so it only runs with the docker
// LDAP up, and everything here can be exercised without it.

const crypto = require('crypto');

// OpenBao stands in as an in-memory store: the ID token key is generated and
// persisted on first use, and the point of most of these tests is what happens
// to a key that IS available.
const mockBaoStore = new Map();
jest.mock('@simpleworkjs/bao-conf', () => ({
	get: jest.fn(async (path) => mockBaoStore.get(path) || null),
	set: jest.fn(async (path, value) => { mockBaoStore.set(path, value); }),
	request: jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })),
	init: jest.fn(async () => {}),
}));

const request = require('supertest');
const app = require('../app');
const { initORM } = require('../models');
const { OAuthClient } = require('../models/oauth_client');
const { OAuthAccessToken, OAuthRefreshToken } = require('../models/oauth_code');
const oauthKeys = require('../utils/oauth_keys');

const RUN = crypto.randomBytes(3).toString('hex');
const created = [];

const makeClient = async (overrides = {}) => {
	const client = await OAuthClient.add({
		name: `oidc-test-${RUN}-${created.length}`,
		created_by: 'test',
		redirect_uris: ['https://app.example.com/callback'],
		...overrides
	});
	created.push(client.id);
	return client;
};

beforeAll(async () => {
	await initORM();
});

afterAll(async () => {
	for (const id of created) {
		const c = await OAuthClient.get(id).catch(() => null);
		if (c) await c.delete().catch(() => {});
	}
});

describe('OIDC discovery', () => {
	test('advertises the JWKS, revocation endpoint and public-client auth', async () => {
		const res = await request(app).get('/.well-known/openid-configuration');
		expect(res.status).toBe(200);

		// A relying party configures itself from this document alone. Every one
		// of these was missing while the provider already supported the flow.
		expect(res.body.jwks_uri).toBe(`${res.body.issuer}/.well-known/jwks.json`);
		expect(res.body.revocation_endpoint).toBe(`${res.body.issuer}/oauth/revoke`);
		expect(res.body.id_token_signing_alg_values_supported).toEqual(['RS256']);
		// `none` is how a public client says it holds no secret.
		expect(res.body.token_endpoint_auth_methods_supported).toContain('none');
		expect(res.body.code_challenge_methods_supported).toContain('S256');
	});
});

describe('JWKS', () => {
	test('serves a usable RSA public key that verifies a token we signed', async () => {
		const res = await request(app).get('/.well-known/jwks.json');
		expect(res.status).toBe(200);
		expect(res.body.keys).toHaveLength(1);

		const jwk = res.body.keys[0];
		expect(jwk.kty).toBe('RSA');
		expect(jwk.alg).toBe('RS256');
		expect(jwk.use).toBe('sig');
		// No private material may ever appear here.
		expect(jwk.d).toBeUndefined();
		expect(jwk.p).toBeUndefined();

		// The end-to-end property that matters: a token signed by the provider's
		// key validates against nothing but this document.
		const jwt = require('jsonwebtoken');
		const keys = await oauthKeys.load();
		const token = jwt.sign({ sub: 'someone' }, keys.privateKeyPem, {
			algorithm: 'RS256', keyid: keys.kid
		});
		const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
		expect(jwt.verify(token, publicKey, { algorithms: ['RS256'] }).sub).toBe('someone');

		// The kid in the header is how a relying party picks the key out of a
		// set, so it has to match what we publish.
		const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
		expect(header.kid).toBe(jwk.kid);
	});
});

describe('client subtypes', () => {
	// The regression: `oidc-client` is in the subtype vocabulary as "OIDC
	// Client" and the console shows it the credentials panel, but only `oauth`
	// minted credentials -- so picking the subtype named for the job produced a
	// client the token endpoint answered "Unknown client_id" for.
	test('an oidc-client subtype is a real client with credentials', async () => {
		const client = await makeClient({ metadata: { subType: 'oidc-client' } });

		expect(client._raw_secret).toBeTruthy();
		const fetched = await OAuthClient.get(client.id);
		expect(fetched.client_id).toBe(client.id);
		// ...and it keeps its own subtype rather than being flattened to `oauth`.
		expect(fetched.metadata.subType).toBe('oidc-client');
		expect(await fetched.verifySecret(client._raw_secret)).toBe(true);
	});

	test('a saml-sp is not treated as an OAuth client', async () => {
		// There is no SAML implementation; minting OAuth credentials for one
		// would dress up something that still does not work.
		const { isOAuthSubtype } = require('../models/oauth_client');
		expect(isOAuthSubtype('saml-sp')).toBe(false);
		expect(isOAuthSubtype('oidc-client')).toBe(true);
		expect(isOAuthSubtype('oauth')).toBe(true);
	});
});

// Both of these reported success and changed nothing, because the wrapper
// mutated `r.metadata` in place and handed the SAME object reference back to
// the ORM -- which compares what it is given against what the row holds, saw no
// difference, and dropped the write. Nothing covered either one.
describe('client updates actually persist', () => {
	test('disabling a client sticks', async () => {
		const client = await makeClient();
		const before = await OAuthClient.get(client.id);
		expect(before.is_valid).toBe(true);

		await before.update({ is_valid: false });

		const after = await OAuthClient.get(client.id);
		expect(after.is_valid).toBe(false);
		expect(after.metadata.is_valid).toBe(false);
	});

	test('rotating the secret retires the old one and installs the new', async () => {
		const client = await makeClient();
		const original = client._raw_secret;

		const rotated = await (await OAuthClient.get(client.id)).rotateSecret();
		expect(rotated).not.toBe(original);

		const after = await OAuthClient.get(client.id);
		// The half that matters during an incident: the leaked secret must stop
		// working. It used to keep working while the newly-issued one did not,
		// so an operator rotating after a suspected leak was left believing they
		// had contained something they had not.
		expect(await after.verifySecret(original)).toBe(false);
		expect(await after.verifySecret(rotated)).toBe(true);
	});

	test('editing redirect URIs sticks', async () => {
		const client = await makeClient();
		await (await OAuthClient.get(client.id)).update({
			redirect_uris: ['https://moved.example.com/cb']
		});
		const after = await OAuthClient.get(client.id);
		expect(after.redirect_uris).toEqual(['https://moved.example.com/cb']);
	});
});

describe('public clients', () => {
	test('the token endpoint refuses a secret from a public client', async () => {
		const client = await makeClient({ is_public: true });

		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code: 'irrelevant',
				client_id: client.id,
				client_secret: client._raw_secret
			});

		// Not ignored: a caller sending a secret believes it is talking to a
		// confidential client, and proceeding quietly hides that.
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('invalid_client');
		expect(res.body.error_description).toMatch(/must not send a client_secret/);
	});

	test('a confidential client still requires its secret', async () => {
		const client = await makeClient();

		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({ grant_type: 'authorization_code', code: 'irrelevant', client_id: client.id });

		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_request');
	});

	test('a disabled client cannot reach the token endpoint', async () => {
		const client = await makeClient();
		// Through OAuthClient.get(), not the object add() returned: only the
		// wrapper's update() maps is_valid into metadata, which is where
		// validity actually lives.
		await (await OAuthClient.get(client.id)).update({ is_valid: false });

		const res = await request(app)
			.post('/oauth/token')
			.type('form')
			.send({
				grant_type: 'authorization_code',
				code: 'irrelevant',
				client_id: client.id,
				client_secret: client._raw_secret
			});

		expect(res.status).toBe(401);
		expect(res.body.error).toBe('invalid_client');
	});
});

// The property a relying party actually depends on: configure yourself from
// discovery, fetch the JWKS it names, and validate an ID token this provider
// issued -- with no shared secret anywhere in the exchange. That is the whole
// point of moving off a single global HS256 key, so it is worth asserting as
// one flow rather than as three separate pieces.
describe('a relying party can validate an ID token from discovery alone', () => {
	test('discovery -> jwks -> verify', async () => {
		const jwt = require('jsonwebtoken');

		const disco = (await request(app).get('/.well-known/openid-configuration')).body;
		expect(disco.jwks_uri).toBeTruthy();

		// Fetch the key set by the path discovery advertises, not a hardcoded one.
		const jwksPath = new URL(disco.jwks_uri).pathname;
		const keySet = (await request(app).get(jwksPath)).body;

		const keys = await oauthKeys.load();
		const idToken = jwt.sign(
			{ iss: disco.issuer, sub: 'alice', aud: 'some-client' },
			keys.privateKeyPem,
			{ algorithm: 'RS256', keyid: keys.kid }
		);

		// Pick the key by kid, exactly as a client library does.
		const header = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64url').toString());
		const jwk = keySet.keys.find(k => k.kid === header.kid);
		expect(jwk).toBeTruthy();

		const claims = jwt.verify(idToken, crypto.createPublicKey({ key: jwk, format: 'jwk' }), {
			algorithms: disco.id_token_signing_alg_values_supported,
			issuer: disco.issuer,
			audience: 'some-client'
		});
		expect(claims.sub).toBe('alice');
	});
});

describe('token revocation (RFC 7009)', () => {
	const revoke = (body) => request(app).post('/oauth/revoke').type('form').send(body);

	test('revokes a refresh token the client owns', async () => {
		const client = await makeClient();
		const rt = await OAuthRefreshToken.add({
			username: 'test', client_id: client.id, scope: 'openid',
			expires_at: Date.now() + 86400000
		});

		const res = await revoke({
			token: rt.token, client_id: client.id, client_secret: client._raw_secret
		});
		expect(res.status).toBe(200);

		const after = await OAuthRefreshToken.get(rt.token);
		expect(after.is_valid).toBe(false);
	});

	test('finds an access token even when the hint is wrong', async () => {
		const client = await makeClient();
		const at = await OAuthAccessToken.add({
			username: 'test', client_id: client.id, scope: 'openid',
			expires_at: Date.now() + 3600000
		});

		// The hint is an optimisation, not a constraint (RFC 7009 §2.1): a
		// client that guesses wrong must not be left holding a live token.
		const res = await revoke({
			token: at.token, token_type_hint: 'refresh_token',
			client_id: client.id, client_secret: client._raw_secret
		});
		expect(res.status).toBe(200);
		expect((await OAuthAccessToken.get(at.token)).is_valid).toBe(false);
	});

	test('will not let one client revoke another client\'s token', async () => {
		const owner = await makeClient();
		const attacker = await makeClient();
		const rt = await OAuthRefreshToken.add({
			username: 'test', client_id: owner.id, scope: 'openid',
			expires_at: Date.now() + 86400000
		});

		const res = await revoke({
			token: rt.token, client_id: attacker.id, client_secret: attacker._raw_secret
		});

		// 200 regardless, per RFC 7009: the endpoint must not become an oracle
		// telling a caller which of the tokens it holds are real.
		expect(res.status).toBe(200);
		expect((await OAuthRefreshToken.get(rt.token)).is_valid).toBe(true);
	});

	test('an unknown token is a 200, not a 404', async () => {
		const client = await makeClient();
		const res = await revoke({
			token: crypto.randomUUID(), client_id: client.id, client_secret: client._raw_secret
		});
		expect(res.status).toBe(200);
	});

	// The operator's equivalent of the above: end every session for an
	// application at once. Exercised at the model level the route uses, because
	// getting the listing API wrong here (list() takes no arguments on these
	// tables and returns index keys, so a where clause is silently ignored)
	// revokes nothing and still reports success.
	test('every token a client holds can be swept at once', async () => {
		const client = await makeClient();
		const other = await makeClient();

		const mine = await Promise.all([
			OAuthAccessToken.add({ username: 'test', client_id: client.id, scope: 'openid', expires_at: Date.now() + 3600000 }),
			OAuthRefreshToken.add({ username: 'test', client_id: client.id, scope: 'openid', expires_at: Date.now() + 86400000 })
		]);
		const theirs = await OAuthRefreshToken.add({
			username: 'test', client_id: other.id, scope: 'openid', expires_at: Date.now() + 86400000
		});

		let swept = 0;
		for (const Model of [OAuthAccessToken, OAuthRefreshToken]) {
			const rows = await Model.listDetail({ client_id: client.id });
			for (const row of rows) {
				if (row.is_valid === false) continue;
				await row.update({ is_valid: false });
				swept++;
			}
		}

		expect(swept).toBe(2);
		expect((await OAuthAccessToken.get(mine[0].token)).is_valid).toBe(false);
		expect((await OAuthRefreshToken.get(mine[1].token)).is_valid).toBe(false);
		// Scoped to the one client -- a sweep that took the whole table with it
		// would log out every application on the deployment.
		expect((await OAuthRefreshToken.get(theirs.token)).is_valid).toBe(true);
	});

	test('a client that cannot authenticate is refused', async () => {
		const client = await makeClient();
		const res = await revoke({
			token: crypto.randomUUID(), client_id: client.id, client_secret: 'not-the-secret'
		});
		expect(res.status).toBe(401);
		expect(res.body.error).toBe('invalid_client');
	});
});
