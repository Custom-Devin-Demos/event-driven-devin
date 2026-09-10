jest.mock('../app/services/devin-api', () => {
  const actual = jest.requireActual('../app/services/devin-api');
  const byKey = {
    'cog_global': {
      orgs: [{ org_id: 'org-gtm', name: 'Devin GTM' }],
      users: { 'org-gtm': [{ user_id: 'gtm-user', email: 'gtm@example.com' }] },
      admins: [{ user_id: 'gtm-admin', email: 'gtm-admin@example.com' }],
    },
    'cog_citi': {
      orgs: [{ org_id: 'org-citi', name: 'Citi' }],
      users: { 'org-citi': [{ user_id: 'citi-user', email: 'Member@Citi.example' }] },
      admins: [{ user_id: 'citi-ent-admin', email: 'ent-admin@example.com' }],
    },
  };
  const ctx = (options = {}) => byKey[options.apiKey || process.env.DEVIN_SERVICE_KEY] || { orgs: [], users: {}, admins: [] };
  return {
    listServiceKeys: actual.listServiceKeys,
    listEnterpriseOrgs: jest.fn((options) => Promise.resolve(ctx(options).orgs)),
    listOrgUsers: jest.fn((orgId, options) => Promise.resolve(ctx(options).users[orgId] || [])),
    listEnterpriseAdmins: jest.fn((options) => Promise.resolve(ctx(options).admins)),
  };
});

const express = require('express');
const http = require('http');
const {
  listEnterpriseOrgs, listOrgUsers, listEnterpriseAdmins, listServiceKeys,
} = require('../app/services/devin-api');

function postJson(server, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('POST /api/resolve-identity across service keys', () => {
  let server;

  beforeAll(async () => {
    process.env.DEVIN_SERVICE_KEY = 'cog_global';
    process.env.DEVIN_SERVICE_KEY_67F2A7BA = 'cog_citi';
    process.env.DEVIN_SERVICE_KEY_OTHER = 'cog_citi';
    const router = require('../app/routes/devin-users');
    const app = express();
    app.use(express.json());
    app.use(router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    delete process.env.DEVIN_SERVICE_KEY;
    delete process.env.DEVIN_SERVICE_KEY_67F2A7BA;
    delete process.env.DEVIN_SERVICE_KEY_OTHER;
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    listEnterpriseOrgs.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  test('listServiceKeys returns the global key first and dedupes per-customer keys', () => {
    expect(listServiceKeys()).toEqual([
      { apiKey: 'cog_global', source: 'default' },
      { apiKey: 'cog_citi', source: '67f2a7ba' },
    ]);
  });

  test('resolves an org only visible to a per-customer key and looks its members up with that key', async () => {
    const res = await postJson(server, '/api/resolve-identity', { orgName: 'citi', email: 'member@citi.example' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId: 'org-citi', userId: 'citi-user' });
    expect(listEnterpriseOrgs).toHaveBeenCalledWith({ apiKey: 'cog_global' });
    expect(listEnterpriseOrgs).toHaveBeenCalledWith({ apiKey: 'cog_citi' });
    expect(listOrgUsers).toHaveBeenCalledWith('org-citi', { apiKey: 'cog_citi' });
  });

  test('falls back to the enterprise admins of the key that owns the org', async () => {
    const res = await postJson(server, '/api/resolve-identity', { orgName: 'Citi', email: 'ent-admin@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.userId).toBe('citi-ent-admin');
    expect(listEnterpriseAdmins).toHaveBeenCalledWith({ apiKey: 'cog_citi' });
  });

  test('still resolves orgs and users under the global key', async () => {
    const res = await postJson(server, '/api/resolve-identity', { orgName: 'Devin GTM', email: 'gtm@example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId: 'org-gtm', userId: 'gtm-user' });
    expect(listEnterpriseOrgs).not.toHaveBeenCalled(); // cached from the earlier request
  });

  test('reports unknown orgs and unknown emails', async () => {
    expect((await postJson(server, '/api/resolve-identity', { orgName: 'Nope' })).status).toBe(404);
    const res = await postJson(server, '/api/resolve-identity', { orgName: 'Citi', email: 'nobody@example.com' });
    expect(res.status).toBe(404);
    expect(res.body.field).toBe('email');
  });
});
