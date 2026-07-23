'use strict';

const request = require('supertest');
const app = require('../app');

// Note: To test this properly, valid LDAP credentials are required in setup.js
// Currently tests are skipped or rely on valid auth token to avoid LDAP auth failures
describe.skip('Directory Admin API', () => {
  let token;

  beforeAll(async () => {
    // A valid admin token is required
    token = 'placeholder_token'; 
  });

  test('POST /api/directory-admin/resources requires hostId for services', async () => {
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .set('auth-token', token)
      .send({
        name: 'Test Service',
        slug: 'app_test_service',
        kind: 'service'
      });
    
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('parent Host');
  });

  test('POST /api/directory-admin/resources creates valid service with parent', async () => {
    // This requires a valid host ID to exist first in a real test
    const res = await request(app)
      .post('/api/directory-admin/resources')
      .set('auth-token', token)
      .send({
        name: 'Test Service',
        slug: 'app_test_service',
        kind: 'service',
        hostId: 'some-uuid-here'
      });
    
    // In a fully mocked environment this would be 200
    expect(res.status).toBe(200);
  });
});
