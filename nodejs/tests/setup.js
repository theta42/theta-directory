'use strict';

const crypto = require('crypto');
const request = require('supertest');
const app = require('../app');
const { initORM } = require('../models');

beforeAll(async () => {
	await initORM();
});

const TEST_CREDS = { uid: 'test', password: 'MyTestPassword!2' };

async function login() {
	const res = await request(app)
		.post('/api/auth/login')
		.send(TEST_CREDS);
	if (!res.body.token) throw new Error('Login failed: ' + JSON.stringify(res.body));
	return res.body.token;
}

function generatePKCE() {
	const verifier = crypto.randomBytes(32)
		.toString('base64')
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	const challenge = crypto.createHash('sha256')
		.update(verifier).digest('base64')
		.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
	return { verifier, challenge };
}

module.exports = { TEST_CREDS, login, generatePKCE, request, app };
