'use strict';

const { EventEmitter } = require('events');

const mockCalls = [];

jest.mock('../utils/site_replicate', () => ({
	replicateToSpokes: (reason) => {
		mockCalls.push(reason);
		return Promise.resolve();
	}
}));

const { replicateOnFinish } = require('../utils/replicate_on_finish');

beforeEach(() => { mockCalls.length = 0; });

function fakeRes(statusCode) {
	const res = new EventEmitter();
	res.statusCode = statusCode;
	return res;
}

test('replicates after a 2xx response finishes', () => {
	const res = fakeRes(200);
	replicateOnFinish(res, 'user-created');
	res.emit('finish');
	expect(mockCalls).toEqual(['user-created']);
});

test('does not replicate after a non-2xx response', () => {
	const res = fakeRes(400);
	replicateOnFinish(res, 'user-created');
	res.emit('finish');
	expect(mockCalls).toEqual([]);
});

test('does not replicate after a 5xx response', () => {
	const res = fakeRes(500);
	replicateOnFinish(res, 'group-created');
	res.emit('finish');
	expect(mockCalls).toEqual([]);
});
