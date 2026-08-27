const request = require('supertest');
const express = require('express');

jest.mock('@simpleworkjs/bao-conf', () => ({
  get: jest.fn(),
  set: jest.fn(),
}));
jest.mock('../utils/permission', () => ({
  byGroup: jest.fn().mockResolvedValue(true),
}));
jest.mock('@simpleworkjs/conf', () => ({
  name: 'Test SSO',
  logo: '/static/img/test.svg',
  icon: '/static/img/test-icon.png',
  smtp: {},
  discovery: {},
  oauth: {},
  voipms: {},
}));
jest.mock('../models/resource', () => ({
  Resource: {
    list: jest.fn(),
    findAncestorSiteSlug: jest.fn(),
  },
}));

const { Resource } = require('../models/resource');
const apiBranding = require('../routes/api_conf_branding');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  req.user = { uid: 'testadmin' };
  next();
});
app.use('/api/conf/branding', apiBranding);

describe('Directory Branding API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/conf/branding returns branding from site metadata', async () => {
    Resource.list.mockResolvedValue([{
      metadata: { isCurrentSite: true, branding: { name: 'My Org', logo: '/logo.svg', icon: '/icon.png' } },
    }]);

    const res = await request(app).get('/api/conf/branding');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('My Org');
    expect(res.body.logo).toBe('/logo.svg');
    expect(res.body.icon).toBe('/icon.png');
  });

  it('GET /api/conf/branding returns empty strings when no branding set', async () => {
    Resource.list.mockResolvedValue([{
      metadata: { isCurrentSite: true },
    }]);

    const res = await request(app).get('/api/conf/branding');

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('');
    expect(res.body.logo).toBe('');
    expect(res.body.icon).toBe('');
  });

  it('POST /api/conf/branding saves to site metadata', async () => {
    const mockUpdate = jest.fn().mockResolvedValue({});
    Resource.list.mockResolvedValue([{
      metadata: { isCurrentSite: true, branding: {} },
      update: mockUpdate,
    }]);

    const res = await request(app).post('/api/conf/branding').send({
      name: 'New Name',
      logo: '/new-logo.svg',
      icon: '/new-icon.png',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      metadata: { isCurrentSite: true, branding: { name: 'New Name', logo: '/new-logo.svg', icon: '/new-icon.png' } },
    });
  });

  it('POST /api/conf/branding preserves existing metadata', async () => {
    const mockUpdate = jest.fn().mockResolvedValue({});
    Resource.list.mockResolvedValue([{
      metadata: { isCurrentSite: true, icon: '/old-icon.png', branding: { name: 'Old', logo: '/old.svg' } },
      update: mockUpdate,
    }]);

    const res = await request(app).post('/api/conf/branding').send({
      name: 'Updated',
    });

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({
      metadata: { isCurrentSite: true, icon: '/old-icon.png', branding: { name: 'Updated' } },
    });
  });

  it('POST /api/conf/branding errors when no site resource', async () => {
    Resource.list.mockResolvedValue([]);

    const res = await request(app).post('/api/conf/branding').send({
      name: 'Test',
    });

    expect(res.status).toBe(500);
  });
});
