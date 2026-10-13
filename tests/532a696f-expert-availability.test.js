/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/532a696f');
const {
  checkExpertAvailability,
  DELIVERY_CENTRES,
  REGION_SCOPES,
  COMPETENCIES,
  CENTRE_LOOKUP_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/532a696f');

const ORIGINAL_LATENCY = [...CENTRE_LOOKUP_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const VALID = { name: 'Jane Doe', company: 'Acme Energy', email: 'jane@acme.com' };

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
  CENTRE_LOOKUP_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Sword Group expert availability', () => {
  test('default scope checks every delivery centre in directory order with defaults', async () => {
    CENTRE_LOOKUP_POLICY.latencyMs = [1, 2];

    const result = await checkExpertAvailability(VALID);

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^SW-[0-9A-F]{8}$/);
    expect(result.company).toBe('Acme Energy');
    expect(result.competency).toEqual({ key: 'digital_services', label: 'Digital Services' });
    expect(result.regions).toEqual({ key: 'all', label: 'All regions' });
    expect(result.centresQueried).toBe(DELIVERY_CENTRES.length);
    expect(result.centres.map((centre) => centre.centreKey)).toEqual(DELIVERY_CENTRES.map((centre) => centre.key));
  });

  test('totals and fastest centre are internally consistent', async () => {
    CENTRE_LOOKUP_POLICY.latencyMs = [1, 2];
    const result = await checkExpertAvailability({ ...VALID, competency: 'data_ai' });
    const today = new Date().toISOString().slice(0, 10);

    result.centres.forEach((centre) => {
      expect(centre.specialistsAvailable).toBeGreaterThanOrEqual(1);
      expect(centre.earliestStart > today).toBe(true);
      const weekday = new Date(`${centre.earliestStart}T00:00:00Z`).getUTCDay();
      expect([0, 6]).not.toContain(weekday);
    });
    expect(result.totalSpecialists).toBe(result.centres.reduce((sum, centre) => sum + centre.specialistsAvailable, 0));
    const minLead = Math.min(...result.centres.map((centre) => centre.leadTimeBusinessDays));
    const fastest = result.centres.find((centre) => centre.leadTimeBusinessDays === minLead);
    expect(result.fastestCentre).toEqual({
      centreKey: fastest.centreKey, region: fastest.region, city: fastest.city, earliestStart: fastest.earliestStart,
    });
  });

  test('results are deterministic for the same request', async () => {
    CENTRE_LOOKUP_POLICY.latencyMs = [1, 2];
    const first = await checkExpertAvailability(VALID);
    const second = await checkExpertAvailability(VALID);

    expect(second.centres).toEqual(first.centres);
    expect(second.totalSpecialists).toBe(first.totalSpecialists);
  });

  test.each(['uk', 'france', 'switzerland', 'usa'])(
    'single-region scope %p returns quickly without alerting',
    async (regions) => {
      const started = Date.now();
      const result = await checkExpertAvailability({ ...VALID, regions });

      expect(Date.now() - started).toBeLessThan(1000);
      expect(result.centresQueried).toBe(1);
      expect(result.centres.map((centre) => centre.centreKey)).toEqual(REGION_SCOPES[regions].centres);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    },
  );

  test.each([
    [{ ...VALID, name: ' ' }, 'NAME_INVALID'],
    [{ ...VALID, company: 'x' }, 'COMPANY_INVALID'],
    [{ ...VALID, email: 'nope' }, 'EMAIL_INVALID'],
    [{ ...VALID, competency: 'unknown' }, 'SELECTION_INVALID'],
    [{ ...VALID, regions: 'unknown' }, 'SELECTION_INVALID'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const response = await request('POST', '/api/532a696f/expert-availability', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, errorClass: 'ValidationError', code });
    expect(response.body.error).toEqual(expect.any(String));
    expect(response.body.requestId).toMatch(/^SW-[0-9A-F]{8}$/);
  });

  test('POST route returns the availability payload for a fast scope', async () => {
    const response = await request('POST', '/api/532a696f/expert-availability', {
      ...VALID,
      regions: 'uk',
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.centres[0]).toMatchObject({ centreKey: 'uk', region: 'UK', city: 'Aberdeen' });
  });

  test('GET catalog lists competencies, region scopes, and centres', async () => {
    const response = await request('GET', '/api/532a696f/catalog');

    expect(response.status).toBe(200);
    expect(response.body.competencies).toHaveLength(COMPETENCIES.length);
    expect(response.body.regions.find((region) => region.key === 'all').centreCount).toBe(DELIVERY_CENTRES.length);
    expect(response.body.centres).toHaveLength(DELIVERY_CENTRES.length);
  });

  test('a latency budget breach triggers the Devin alert', async () => {
    CENTRE_LOOKUP_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const result = await checkExpertAvailability({
      ...VALID,
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: '',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const payload = createSessionAndAlert.mock.calls[0][0];
    expect(payload.errorType).toBe('LatencyBudgetExceeded');
    expect(payload.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/532a696f\/expert-availability took \d+ms \(budget 1ms\)$/);
    expect(payload.culprit).toBe('app/services/verticals/532a696f.js — collectRegionalAvailability');
    expect(payload.customer).toBe('532a696f');
    expect(payload.devinUserId).toBe('user-1');
    expect(payload.devinOrgId).toBe('org-1');
    expect(payload.promptAppendix).toContain('collectRegionalAvailability');
    expect(payload.extra.centresQueried).toBe(15);
  });
});
