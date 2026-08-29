'use strict';

const express = require('express');
const request = require('supertest');
const { initORM } = require('../models');
const { SubtypeTemplate } = require('../models/subtype_template');
const { Resource, ResourceEdge } = require('../models/resource');
const middleware = require('../middleware/auth');
const permission = require('../utils/permission');

let app;
let authSpy, permSpy;

async function seedSite() {
  await Resource.create({
    id: 'site-a', kind: 'site', name: 'Site A', slug: 'site_a', created_on: 1
  });
  await Resource.create({
    id: 'host-a', kind: 'host', name: 'Host A', slug: 'host_a', metadata: { subType: 'linux' }, created_on: 1
  });
  await ResourceEdge.create({
    id: require('crypto').randomUUID(), parentId: 'site-a', childId: 'host-a', relation: 'hosts'
  });
}

describe('SubtypeTemplate API and validation', () => {
  beforeAll(async () => {
    await initORM();
    authSpy = jest.spyOn(middleware, 'auth').mockImplementation((req, res, next) => {
      req.user = { uid: 'admin', dn: 'cn=admin,dc=theta,dc=local' };
      next();
    });
    permSpy = jest.spyOn(permission, 'byGroup').mockImplementation(() => Promise.resolve(true));

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { uid: 'admin', dn: 'cn=admin,dc=theta,dc=local' };
      next();
    });
    app.use('/api/subtype-templates', require('../routes/api_subtype_template'));
    app.use('/api/directory-admin', require('../routes/api_directory_admin'));
  });

  afterAll(() => {
    authSpy.mockRestore();
    permSpy.mockRestore();
  });

  beforeEach(async () => {
    const existing = await SubtypeTemplate.list();
    for (const t of existing) await t.delete();
    const edges = await ResourceEdge.list();
    for (const e of edges) await e.delete();
    const resources = await Resource.list();
    for (const r of resources) await r.delete();
    await seedSite();
  });

  test('seedDefaults creates default templates', async () => {
    await SubtypeTemplate.seedDefaults();
    const templates = await SubtypeTemplate.list();
    const slugs = templates.map(t => t.slug);
    expect(slugs).toContain('linux');
    expect(slugs).toContain('theta-agent');
    expect(slugs).toContain('port-forward');
  });

  test('POST /api/subtype-templates creates a template', async () => {
    const res = await request(app)
      .post('/api/subtype-templates')
      .send({
        slug: 'custom-svc',
        name: 'Custom Service',
        target_kind: 'service',
        valid_parent_types: ['host'],
        schema: {
          required: ['port'],
          properties: {
            port: { type: 'number', description: 'Port' },
            protocol: { type: 'string', enum: ['tcp', 'udp'] }
          }
        }
      });
    expect(res.status).toBe(200);
    expect(res.body.template.slug).toBe('custom-svc');
  });

  test('directory admin rejects resource with wrong subtype kind', async () => {
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'host-only-subtype',
      name: 'Host Only',
      target_kind: 'host',
      created_on: 1
    });
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .send({
        name: 'Bad Service',
        slug: 'bad-service',
        kind: 'service',
        hostId: 'host-a',
        metadata: { subType: 'host-only-subtype' }
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not valid for kind 'service'/);
  });

  // JSON Schema semantics: undeclared keys are allowed unless the template
  // opts into `additionalProperties: false`. Discovery plugins legitimately
  // write whatever a device reports (`node`, `powerState`, `composeProject`),
  // so a template that rejected everything it had not declared would make
  // every discovered resource uneditable.
  test('an undeclared field is allowed by default', async () => {
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'open-svc',
      name: 'Open Service',
      target_kind: 'service',
      valid_parent_types: ['host'],
      schema: { properties: { port: { type: 'number' } } },
      created_on: 1
    });
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .send({
        name: 'Open Field Service',
        slug: 'open-field-service',
        kind: 'service',
        hostId: 'host-a',
        metadata: { subType: 'open-svc', port: 443, powerState: 'On' }
      });
    expect(res.status).toBe(200);
  });

  test('additionalProperties:false rejects an undeclared field', async () => {
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'strict-svc',
      name: 'Strict Service',
      target_kind: 'service',
      valid_parent_types: ['host'],
      schema: { properties: { port: { type: 'number' } }, additionalProperties: false },
      created_on: 1
    });
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .send({
        name: 'Bad Field Service',
        slug: 'bad-field-service',
        kind: 'service',
        hostId: 'host-a',
        metadata: { subType: 'strict-svc', port: 443, extraField: 'x' }
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Unknown field 'extraField'/);
  });

  test('a declared field is still type-checked', async () => {
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'open-svc',
      name: 'Open Service',
      target_kind: 'service',
      valid_parent_types: ['host'],
      schema: { properties: { port: { type: 'number' } } },
      created_on: 1
    });
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .send({
        name: 'Wrong Type Service',
        slug: 'wrong-type-service',
        kind: 'service',
        hostId: 'host-a',
        metadata: { subType: 'open-svc', port: 'not-a-number' }
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/'port' must be a number/);
  });

  test('environment is restricted to the declared set', async () => {
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'open-svc',
      name: 'Open Service',
      target_kind: 'service',
      valid_parent_types: ['host'],
      schema: { properties: { port: { type: 'number' } } },
      created_on: 1
    });
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .send({
        name: 'Bad Env Service',
        slug: 'bad-env-service',
        kind: 'service',
        hostId: 'host-a',
        metadata: { subType: 'open-svc', environment: 'staging' }
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/environment must be one of/);
  });

  test('parent SUBTYPE is enforced, not just parent kind', async () => {
    // A guest is a host under a host, so the kind check alone would happily let
    // you hang a Proxmox LXC off a laptop.
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'guest-only', name: 'Guest', target_kind: 'host',
      valid_parent_types: ['host'], valid_parent_subtypes: ['proxmox'], created_on: 1
    });

    const wrong = await request(app)
      .post('/api/directory-admin/resources')
      .send({ name: 'Guest', slug: 'guest-bad', kind: 'host', hostId: 'host-a',
              metadata: { subType: 'guest-only' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/cannot be created under a 'linux' parent/);

    // host-a is subType `linux`; make a proxmox parent and it is allowed.
    await Resource.create({
      id: 'host-pve', kind: 'host', name: 'PVE', slug: 'host_pve',
      metadata: { subType: 'proxmox' }, created_on: 1
    });
    await ResourceEdge.create({
      id: require('crypto').randomUUID(), parentId: 'site-a', childId: 'host-pve', relation: 'hosts'
    });
    const ok = await request(app)
      .post('/api/directory-admin/resources')
      .send({ name: 'Guest', slug: 'guest-good', kind: 'host', hostId: 'host-pve',
              metadata: { subType: 'guest-only' } });
    expect(ok.status).toBe(200);
  });

  test('directory admin rejects wrong parent type for subtype', async () => {
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'service-only',
      name: 'Service Only',
      target_kind: 'service',
      valid_parent_types: ['host'],
      created_on: 1
    });
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .send({
        name: 'Wrong Parent',
        slug: 'wrong-parent',
        kind: 'service',
        hostId: 'site-a',
        metadata: { subType: 'service-only' }
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be created under parent kind 'site'/);
  });

  test('directory admin accepts valid subtype fields', async () => {
    await SubtypeTemplate.create({
      id: require('crypto').randomUUID(),
      slug: 'valid-svc',
      name: 'Valid Service',
      target_kind: 'service',
      valid_parent_types: ['host'],
      schema: {
        required: ['port'],
        properties: { port: { type: 'number' }, protocol: { type: 'string', enum: ['tcp', 'udp'] } }
      },
      created_on: 1
    });
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .send({
        name: 'Good Service',
        slug: 'good-service',
        kind: 'service',
        hostId: 'host-a',
        metadata: { subType: 'valid-svc', port: 443, protocol: 'tcp' }
      });
    expect(res.status).toBe(200);
    expect(res.body.results.metadata.port).toBe(443);
  });
});
