'use strict';

// A mesh IP identifies a peer site; it is not an address this container can
// dial. WireGuard lives in the jump-host container's namespace, so
// 172.24.<idx>.1 is unreachable from here and from theta-proxy, and nothing
// listened on :3001 there anyway. The reachable address is the LOCAL
// gateway's per-peer forwarding port.

describe('mesh_route', () => {
	const load = () => {
		jest.resetModules();
		return require('../utils/mesh_route');
	};

	afterEach(() => { delete process.env.JUMP_INTERNAL_URL; });

	describe('meshIndexFrom', () => {
		test('extracts the site octet from a gateway mesh address', () => {
			const { meshIndexFrom } = load();
			expect(meshIndexFrom('172.24.1.1')).toBe(1);
			expect(meshIndexFrom('172.24.7.1')).toBe(7);
			expect(meshIndexFrom('172.24.254.1')).toBe(254);
		});

		test('rejects anything that is not a mesh address', () => {
			const { meshIndexFrom } = load();
			expect(meshIndexFrom('10.0.0.5')).toBeNull();
			expect(meshIndexFrom('192.168.1.1')).toBeNull();
			expect(meshIndexFrom('')).toBeNull();
			expect(meshIndexFrom(null)).toBeNull();
			expect(meshIndexFrom('172.24.0.1')).toBeNull();   // 0 is reserved
			expect(meshIndexFrom('172.24.255.1')).toBeNull(); // 255 is reserved
			expect(meshIndexFrom('not-an-ip')).toBeNull();
		});
	});

	test('the derived port matches jump-host\'s base + index scheme', () => {
		const { meshServicePort, MESH_SERVICE_PORT_BASE } = load();
		expect(MESH_SERVICE_PORT_BASE).toBe(30000);
		expect(meshServicePort(1)).toBe(30001);
		expect(meshServicePort(42)).toBe(30042);
	});

	describe('meshServiceTarget', () => {
		test('routes via the local gateway, never at the peer mesh IP itself', () => {
			process.env.JUMP_INTERNAL_URL = 'http://jump-host:3002';
			const { meshServiceTarget } = load();
			expect(meshServiceTarget('172.24.5.1')).toEqual({ host: 'jump-host', port: 30005, meshIndex: 5 });
		});

		test('is null when no gateway is configured, so callers fall back', () => {
			const { meshServiceTarget } = load();
			expect(meshServiceTarget('172.24.5.1')).toBeNull();
		});

		test('is null for a non-mesh IP', () => {
			process.env.JUMP_INTERNAL_URL = 'http://jump-host:3002';
			const { meshServiceTarget } = load();
			expect(meshServiceTarget('10.1.2.3')).toBeNull();
		});

		test('tolerates an unparseable JUMP_INTERNAL_URL', () => {
			process.env.JUMP_INTERNAL_URL = 'nonsense';
			const { meshServiceTarget } = load();
			expect(meshServiceTarget('172.24.5.1')).toBeNull();
		});
	});
});
