'use strict';

const { recordFactSources } = require('../utils/fact_sources');

describe('fact_sources', () => {
  test('echoes fields under facts_by_source, stamped with observed_at', () => {
    const meta = { ram_total_gb: 12, macAddress: '6e:65:df:28:bb:21' };
    recordFactSources(meta, 'proxmox-718', { ram_total_gb: 12, macAddress: '6e:65:df:28:bb:21' });

    expect(meta.facts_by_source['proxmox-718']).toMatchObject({
      ram_total_gb: 12,
      macAddress: '6e:65:df:28:bb:21'
    });
    expect(typeof meta.facts_by_source['proxmox-718'].observed_at).toBe('number');
  });

  test('does not touch the flat fields it is called alongside', () => {
    const meta = { ram_total_gb: 12 };
    recordFactSources(meta, 'proxmox-718', { ram_total_gb: 12 });
    expect(meta.ram_total_gb).toBe(12);
  });

  test('excludes bookkeeping keys from the echo', () => {
    const meta = {};
    recordFactSources(meta, 'proxmox-718', {
      ram_total_gb: 12,
      discovery_sources: ['proxmox-718'],
      last_seen: Date.now(),
      facts_by_source: { should: 'not appear' }
    });
    const echoed = meta.facts_by_source['proxmox-718'];
    expect(echoed.ram_total_gb).toBe(12);
    expect(echoed.discovery_sources).toBeUndefined();
    expect(echoed.last_seen).toBeUndefined();
    expect(echoed.facts_by_source).toBeUndefined();
  });

  test('two sources both echo, side by side, even when they collide on a field', () => {
    const meta = {};
    recordFactSources(meta, 'proxmox-718', { ram_total_gb: 12 });
    recordFactSources(meta, 'theta-agent', { ram_total_gb: 11.8 });

    expect(meta.facts_by_source['proxmox-718'].ram_total_gb).toBe(12);
    expect(meta.facts_by_source['theta-agent'].ram_total_gb).toBe(11.8);
  });

  test('is a no-op for missing arguments rather than throwing', () => {
    expect(() => recordFactSources(null, 'x', {})).not.toThrow();
    expect(() => recordFactSources({}, null, {})).not.toThrow();
    expect(() => recordFactSources({}, 'x', null)).not.toThrow();
  });
});
