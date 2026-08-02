const request = require('supertest');
const express = require('express');

// Mock dependencies before requiring the route
jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
}));
jest.mock('../utils/permission', () => ({
  byGroup: jest.fn().mockResolvedValue(true),
}));
jest.mock('@simpleworkjs/conf', () => ({}));

const baoConf = require('@simpleworkjs/bao-conf');
const apiConf = require('../routes/api_conf');

const app = express();
app.use(express.json());
// Add a mock user for the permission check
app.use((req, res, next) => {
  req.user = { uid: 'testadmin' };
  next();
});
app.use('/api/conf', apiConf);

describe('Proxy Conf API (Vault Integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/conf/proxy returns proxy conf with masked secrets', async () => {
    baoConf.get.mockResolvedValueOnce({
      oidc: { issuer: 'https://test', clientId: 'cid', clientSecret: 'real_secret' },
      ldap: { bindPassword: 'real_ldap_password' }
    });

    const res = await request(app).get('/api/conf/proxy');
    
    expect(res.status).toBe(200);
    expect(res.body.oidc.issuer).toBe('https://test');
    expect(res.body.oidc.clientSecret).toBe('********'); // MASKED
    expect(res.body.ldap.bindPassword).toBe('********'); // MASKED
    expect(baoConf.get).toHaveBeenCalledWith('proxy/conf');
  });

  it('POST /api/conf/proxy merges configuration securely to OpenBao', async () => {
    baoConf.get.mockResolvedValueOnce({
      oidc: { clientSecret: 'old_secret' },
      ldap: { bindPassword: 'old_ldap' }
    });

    const payload = {
      oidc: { issuer: 'https://new', clientSecret: '********' }, // Admin left it unchanged
      ldap: { bindPassword: 'new_password' }
    };

    const res = await request(app)
      .post('/api/conf/proxy')
      .send(payload);

    expect(res.status).toBe(200);
    expect(baoConf.set).toHaveBeenCalledTimes(1);
    const saved = baoConf.set.mock.calls[0][1];

    expect(saved.oidc.issuer).toBe('https://new');
    expect(saved.oidc.clientSecret).toBe('old_secret'); // Preserved because incoming was mask
    expect(saved.ldap.bindPassword).toBe('new_password'); // Overwritten because incoming was new
  });
});
