'use strict';

// The vocabulary against the real ORM: seeding is idempotent, does not clobber
// operator edits, and the cache that templateFor() reads is actually populated
// from it. The unit tests above work off SubtypeTemplate.defaults() in memory,
// which cannot see a seed that fails to write or a cache that never loads.

require('./setup');
const crypto = require('crypto');
const { SubtypeTemplate } = require('../models/subtype_template');
const { templateFor, refreshTemplateCache, _setTemplateCache } = require('../services/subtype_templates');

async function clearTemplates() {
  for (const t of await SubtypeTemplate.list()) await t.delete();
}

describe('seedDefaults', () => {
  beforeEach(clearTemplates);
  afterEach(() => _setTemplateCache(null));
  afterAll(clearTemplates);

  test('seeds the whole vocabulary and is idempotent', async () => {
    const first = await SubtypeTemplate.seedDefaults();
    expect(first).toBe(SubtypeTemplate.defaults().length);
    const afterFirst = (await SubtypeTemplate.list()).length;

    const second = await SubtypeTemplate.seedDefaults();
    expect(second).toBe(0);
    expect((await SubtypeTemplate.list()).length).toBe(afterFirst);
  });

  test('an operator edit survives a re-seed', async () => {
    await SubtypeTemplate.seedDefaults();
    const linux = (await SubtypeTemplate.list({ where: { slug: 'linux' } }))[0];
    await linux.update({ name: 'Our Standard Build', ssh_capable: false });

    await SubtypeTemplate.seedDefaults();

    const after = (await SubtypeTemplate.list({ where: { slug: 'linux' } }))[0];
    expect(after.name).toBe('Our Standard Build');
    expect(after.ssh_capable).toBe(false);
  });

  test('the persisted flags round-trip and reach templateFor', async () => {
    await SubtypeTemplate.seedDefaults();
    const loaded = await refreshTemplateCache();
    expect(loaded).toBe(SubtypeTemplate.defaults().length);

    expect(templateFor({ kind: 'host', metadata: { subType: 'linux' } }).sshCapable).toBe(true);
    expect(templateFor({ kind: 'host', metadata: { subType: 'unknown' } }).sshCapable).toBe(false);
    expect(templateFor({ kind: 'host', metadata: { subType: 'printer' } }).sshCapable).toBe(false);
    expect(templateFor({ kind: 'service', metadata: { subType: 'systemd' } }).inheritsHost).toBe(true);
    expect(templateFor({ kind: 'service', metadata: { subType: 'theta-agent' } }).ownGroups).toBe(false);
    expect(templateFor({ kind: 'service', metadata: { subType: 'web' } }).ownGroups).toBe(true);
  });

  test('an operator turning off ssh_capable takes effect after a refresh', async () => {
    await SubtypeTemplate.seedDefaults();
    await refreshTemplateCache();
    expect(templateFor({ kind: 'host', metadata: { subType: 'laptop' } }).sshCapable).toBe(true);

    const laptop = (await SubtypeTemplate.list({ where: { slug: 'laptop' } }))[0];
    await laptop.update({ ssh_capable: false });
    await refreshTemplateCache();

    expect(templateFor({ kind: 'host', metadata: { subType: 'laptop' } }).sshCapable).toBe(false);
  });

  test('a brand new operator-defined subtype works end to end', async () => {
    await SubtypeTemplate.create({
      id: crypto.randomUUID(), slug: 'nas', name: 'NAS', target_kind: 'host',
      valid_parent_types: ['site'], ssh_capable: true, created_on: 1
    });
    await refreshTemplateCache();
    expect(templateFor({ kind: 'host', metadata: { subType: 'nas' } }).sshCapable).toBe(true);
  });

  test('a database that cannot be read leaves the previous answers standing', async () => {
    await SubtypeTemplate.seedDefaults();
    await refreshTemplateCache();
    const before = templateFor({ kind: 'host', metadata: { subType: 'linux' } }).sshCapable;

    const listSpy = jest.spyOn(SubtypeTemplate, 'list').mockRejectedValue(new Error('db is down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await refreshTemplateCache()).toBe(0);
      // Not wiped: a failed refresh must not silently change access decisions.
      expect(templateFor({ kind: 'host', metadata: { subType: 'linux' } }).sshCapable).toBe(before);
    } finally {
      listSpy.mockRestore();
      warn.mockRestore();
    }
  });
});
