/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/2ecabf0c');
const {
  matchSpecialists,
  COMPANIES,
  ROUTING_OPTIONS,
  AVAILABILITY_LOOKUP_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/2ecabf0c');

const ORIGINAL_LATENCY = [...AVAILABILITY_LOOKUP_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const VALID = { businessName: 'Heartland Home Medical Supply', email: 'ops@heartlandhme.com' };

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({
        host: '127.0.0.1', port, path, method, headers,
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  AVAILABILITY_LOOKUP_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('VGM Group specialist match', () => {
  test('default routing matches every VGM Group company in directory order', async () => {
    AVAILABILITY_LOOKUP_POLICY.latencyMs = [1, 3];

    const result = await matchSpecialists(VALID);

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^VGM-[0-9A-F]{8}$/);
    expect(result.routing).toEqual({ key: 'all', label: 'All VGM Group companies' });
    expect(result.industry.key).toBe('healthcare');
    expect(result.companiesQueried).toBe(COMPANIES.length);
    expect(result.matches.map((m) => m.companyKey)).toEqual(COMPANIES.map((c) => c.key));
    result.matches.forEach((m) => {
      expect(m.specialist).toMatch(/^\w+ \w+$/);
      expect(new Date(m.nextAvailable).getTime()).toBeGreaterThan(Date.now());
      expect([0, 6]).not.toContain(new Date(m.nextAvailable).getUTCDay());
    });
  });

  test('matches are deterministic for the same business', async () => {
    AVAILABILITY_LOOKUP_POLICY.latencyMs = [1, 2];
    const first = await matchSpecialists(VALID);
    const second = await matchSpecialists(VALID);
    expect(second.matches).toEqual(first.matches);
  });

  test.each(['vgm_associates', 'vgm_insurance', 'vgm_forbin'])('single-company routing %p checks one company quickly', async (routing) => {
    const started = Date.now();
    const result = await matchSpecialists({ ...VALID, routing, industry: 'all_industry' });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.companiesQueried).toBe(1);
    expect(result.matches.map((m) => m.companyKey)).toEqual(ROUTING_OPTIONS[routing].companies);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [{ ...VALID, businessName: ' ' }, 'BUSINESS_NAME_INVALID'],
    [{ ...VALID, email: 'not-an-email' }, 'EMAIL_INVALID'],
    [{ ...VALID, routing: 'everyone' }, 'ROUTING_INVALID'],
    [{ ...VALID, industry: 'retail' }, 'ROUTING_INVALID'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const response = await request('POST', '/api/2ecabf0c/specialist-match', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, errorClass: 'ValidationError', code });
    expect(response.body.error).toEqual(expect.any(String));
    expect(response.body).toHaveProperty('requestId');
  });

  test('POST route returns the specialist match payload', async () => {
    AVAILABILITY_LOOKUP_POLICY.latencyMs = [1, 2];
    const response = await request('POST', '/api/2ecabf0c/specialist-match', { ...VALID, routing: 'vgm_forbin' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.matches[0].company).toBe('VGM Forbin');
  });

  test('GET companies lists the directory and routing options', async () => {
    const response = await request('GET', '/api/2ecabf0c/companies');

    expect(response.status).toBe(200);
    expect(response.body.companies).toHaveLength(COMPANIES.length);
    expect(response.body.routingOptions.find((o) => o.key === 'all').companyCount).toBe(COMPANIES.length);
  });

  test('a latency budget breach triggers the Devin alert', async () => {
    AVAILABILITY_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const result = await matchSpecialists({
      ...VALID, devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: '',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const payload = createSessionAndAlert.mock.calls[0][0];
    expect(payload.errorType).toBe('LatencyBudgetExceeded');
    expect(payload.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/2ecabf0c\/specialist-match took \d+ms \(budget 1ms\)$/);
    expect(payload.culprit).toBe('app/services/verticals/2ecabf0c.js — collectSpecialistAvailability');
    expect(payload.customer).toBe('2ecabf0c');
    expect(payload.devinUserId).toBe('user-1');
    expect(payload.devinOrgId).toBe('org-1');
    expect(payload.promptAppendix).toContain('collectSpecialistAvailability');
    expect(payload.extra.companiesQueried).toBe(COMPANIES.length);
  });
});
