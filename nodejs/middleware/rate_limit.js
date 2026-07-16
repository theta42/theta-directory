'use strict';

const { rateLimit } = require('express-rate-limit');

const onLimitReached = (req, res, options) => {
	console.warn(`Rate limit hit: ${req.ip} ${req.method} ${req.path}`);
};

const handler = (message) => (req, res, next, options) => {
	onLimitReached(req, res, options);
	res.status(429).json(message);
};

exports.login = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 10,
	handler: handler({ name: 'RateLimitError', message: 'Too many login attempts, try again later.' }),
});

exports.passwordReset = rateLimit({
	windowMs: 60 * 60 * 1000,
	limit: 5,
	handler: handler({ name: 'RateLimitError', message: 'Too many password reset requests, try again later.' }),
});

exports.otpRequest = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 5,
	handler: handler({ name: 'RateLimitError', message: 'Too many OTP requests, try again later.' }),
});

exports.otpVerify = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 10,
	handler: handler({ name: 'RateLimitError', message: 'Too many verification attempts, try again later.' }),
});

exports.invite = rateLimit({
	windowMs: 60 * 60 * 1000,
	limit: 20,
	handler: handler({ name: 'RateLimitError', message: 'Too many requests, try again later.' }),
});

// Public, unauthenticated, reads from disk on every request -- generous
// since it's just docs, but still throttled per IP.
exports.docs = rateLimit({
	windowMs: 60 * 1000,
	limit: 120,
	handler: handler({ name: 'RateLimitError', message: 'Too many requests, try again later.' }),
});
