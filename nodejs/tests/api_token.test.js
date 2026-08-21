'use strict';

const express = require('express');
const request = require('supertest');
const { initORM } = require('../models');
const { ApiToken } = require('../models/api_token');
const siteReplicate = require('../utils/site_replicate');

describe('API Tokens (PATs) & Live Resync Triggers', () => {
	let app;
	let replicateSpy;

	beforeAll(async () => {
		await initORM();
		app = express();
		app.use(express.json());
		// Inject mock authenticated user as middleware.auth does
		app.use((req, res, next) => {
			req.user = { uid: 'alice' };
			next();
		});
		app.use('/api/api-token', require('../routes/api_token'));
	});

	beforeEach(() => {
		replicateSpy = jest.spyOn(siteReplicate, 'replicateToSpokes').mockImplementation(() => Promise.resolve());
	});

	afterEach(() => {
		replicateSpy.mockRestore();
	});

	test('POST /api/api-token creates a token and triggers resync push', async () => {
		const res = await request(app)
			.post('/api/api-token')
			.send({ name: 'Test Token', description: 'For CI testing', expires_in_days: 30 });

		expect(res.status).toBe(200);
		expect(res.body.token).toMatch(/^sso_[0-9a-f]{24}_[0-9a-f]{48}$/);
		expect(res.body.results.name).toBe('Test Token');
		expect(res.body.results.id).toBeDefined();

		const tokenId = res.body.results.id;
		const rawToken = res.body.token;

		// Verify replicateToSpokes was called with 'api-token-created'
		expect(replicateSpy).toHaveBeenCalledWith('api-token-created');

		// Authenticate with the freshly minted token model directly
		const authedToken = await ApiToken.authenticate(rawToken);
		expect(authedToken.id).toBe(tokenId);
		expect(authedToken.created_by).toBe('alice');

		// PUT /api/api-token/:id updates token and triggers resync push
		replicateSpy.mockClear();
		const updateRes = await request(app)
			.put(`/api/api-token/${tokenId}`)
			.send({ name: 'Updated Token Name' });

		expect(updateRes.status).toBe(200);
		expect(updateRes.body.results.name).toBe('Updated Token Name');
		expect(replicateSpy).toHaveBeenCalledWith('api-token-updated');

		// POST /api/api-token/:id/rotate rotates token and triggers resync push
		replicateSpy.mockClear();
		const rotateRes = await request(app)
			.post(`/api/api-token/${tokenId}/rotate`);

		expect(rotateRes.status).toBe(200);
		expect(rotateRes.body.token).toMatch(/^sso_[0-9a-f]{24}_[0-9a-f]{48}$/);
		expect(rotateRes.body.token).not.toBe(rawToken);
		expect(replicateSpy).toHaveBeenCalledWith('api-token-rotated');

		// Old token is now rejected by model authenticate
		await expect(ApiToken.authenticate(rawToken)).rejects.toThrow('InvalidApiToken');

		// New rotated token works
		const rotatedAuthed = await ApiToken.authenticate(rotateRes.body.token);
		expect(rotatedAuthed.id).toBe(tokenId);

		// DELETE /api/api-token/:id revokes token and triggers resync push
		replicateSpy.mockClear();
		const deleteRes = await request(app)
			.delete(`/api/api-token/${tokenId}`);

		expect(deleteRes.status).toBe(200);
		expect(replicateSpy).toHaveBeenCalledWith('api-token-revoked');

		// Revoked token is rejected
		await expect(ApiToken.authenticate(rotateRes.body.token)).rejects.toThrow('InvalidApiToken');
	});
});
