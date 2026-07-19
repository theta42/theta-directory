'use strict';

const request = require('supertest');
const app = require('../app');
const conf = require('@simpleworkjs/conf');

const ORIG_LDAP = { ...conf.ldap };
const ORIG_OAUTH = { ...(conf.oauth || {}) };

function restoreConf() {
  conf.ldap = { ...conf.ldap, ...ORIG_LDAP };
  conf.oauth = { ...(conf.oauth || {}), ...ORIG_OAUTH };
}

beforeEach(() => {
  // Start each test from a known state; the local secrets.js may set an issuer.
  conf.ldap = { ...conf.ldap, ldapsHost: '', ldapsPort: 636 };
  if (conf.oauth) conf.oauth.issuer = '';
});

afterAll(() => {
  restoreConf();
});

describe('GET /integrations', () => {
  test('renders and derives LDAPS URL from the request host by default', async () => {
    const res = await request(app)
      .get('/integrations')
      .set('Host', 'sso.example.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('ldaps://sso.example.com:636');
  });

  test('uses conf.ldap.ldapsHost when set', async () => {
    conf.ldap = { ...conf.ldap, ldapsHost: 'ldap.internal.example.com', ldapsPort: 1636 };

    const res = await request(app)
      .get('/integrations')
      .set('Host', 'public.example.com');

    expect(res.status).toBe(200);
    expect(res.text).toContain('ldaps://ldap.internal.example.com:1636');
    expect(res.text).not.toContain('ldaps://public.example.com:636');
    expect(res.text).toContain('Custom <code>conf.ldap.ldapsHost</code>');
  });
});
