/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/485ddc93');
const {
  searchObituaries,
  REGIONS,
  SEARCH_SCOPES,
  ARCHIVE_INDEX_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/485ddc93');

const ORIGINAL_LATENCY = [...ARCHIVE_INDEX_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const VALID = { name: 'Margaret Ellis' };

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

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

afterEach(() => {
  ARCHIVE_INDEX_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Tribute Technology obituary search', () => {
  test('default scope searches every Tribute Archive region in directory order', async () => {
    ARCHIVE_INDEX_POLICY.latencyMs = [1, 3];

    const result = await searchObituaries(VALID);

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^TT-[0-9A-F]{8}$/);
    expect(result.scope).toEqual({ key: 'all', label: 'All Tribute Archive regions' });
    expect(result.dateRange.key).toBe('last_12_months');
    expect(result.regionsQueried).toBe(REGIONS.length);
    expect(result.regions.map((r) => r.regionKey)).toEqual(REGIONS.map((r) => r.key));
    expect(result.funeralHomesSearched).toBe(REGIONS.reduce((sum, r) => sum + r.funeralHomes, 0));
    expect(result.totalResults).toBe(result.regions.reduce((sum, r) => sum + r.obituaries.length, 0));
  });

  test('obituaries are internally consistent and dated no later than today', async () => {
    ARCHIVE_INDEX_POLICY.latencyMs = [1, 2];
    const result = await searchObituaries({ ...VALID, dateRange: 'last_30_days' });
    const earliest = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);

    result.regions.forEach((region) => {
      const meta = REGIONS.find((r) => r.key === region.regionKey);
      expect(region.obituaries.length).toBeGreaterThan(0);
      region.obituaries.forEach((obit) => {
        const year = Number(obit.dateOfDeath.slice(0, 4));
        expect(obit.name).toBe('Margaret Ellis');
        expect(obit.dateOfDeath < todayUtc()).toBe(true);
        expect(obit.dateOfDeath >= earliest).toBe(true);
        expect(obit.obituaryId).toMatch(new RegExp(`^TA-${year}-[0-9A-F]{7}$`));
        expect(obit.birthYear).toBe(year - obit.age);
        expect(meta.cities.map(([city, state]) => `${city}, ${state}`)).toContain(`${obit.city}, ${obit.state}`);
      });
    });
  });

  test('single-word queries return a full name with that surname', async () => {
    ARCHIVE_INDEX_POLICY.latencyMs = [1, 2];
    const result = await searchObituaries({ name: 'o\'brien', scope: 'southeast' });
    result.regions[0].obituaries.forEach((obit) => expect(obit.name).toMatch(/^\w+ O'Brien$/));
  });

  test('results are deterministic for the same query', async () => {
    ARCHIVE_INDEX_POLICY.latencyMs = [1, 2];
    const first = await searchObituaries(VALID);
    const second = await searchObituaries(VALID);
    expect(second.regions).toEqual(first.regions);
  });

  test.each(['southeast', 'great_lakes', 'texas'])('single-region scope %p searches one region quickly', async (scope) => {
    const started = Date.now();
    const result = await searchObituaries({ ...VALID, scope, dateRange: 'last_30_days' });

    expect(Date.now() - started).toBeLessThan(1000);
    expect(result.regionsQueried).toBe(1);
    expect(result.regions.map((r) => r.regionKey)).toEqual(SEARCH_SCOPES[scope].regions);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [{ name: ' ' }, 'NAME_INVALID'],
    [{ name: 'R2-D2' }, 'NAME_INVALID'],
    [{ ...VALID, scope: 'everywhere' }, 'SCOPE_INVALID'],
    [{ ...VALID, dateRange: 'forever' }, 'SCOPE_INVALID'],
  ])('rejects invalid input with a structured 400 (%#)', async (body, code) => {
    const response = await request('POST', '/api/485ddc93/obituary-search', body);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, errorClass: 'ValidationError', code });
    expect(response.body.error).toEqual(expect.any(String));
    expect(response.body).toHaveProperty('requestId');
  });

  test('POST route returns the obituary search payload', async () => {
    ARCHIVE_INDEX_POLICY.latencyMs = [1, 2];
    const response = await request('POST', '/api/485ddc93/obituary-search', { ...VALID, scope: 'texas' });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.regions[0].region).toBe('Texas & South Central');
  });

  test('GET regions lists the directory and search scopes', async () => {
    const response = await request('GET', '/api/485ddc93/regions');

    expect(response.status).toBe(200);
    expect(response.body.regions).toHaveLength(REGIONS.length);
    expect(response.body.scopes.find((s) => s.key === 'all').regionCount).toBe(REGIONS.length);
  });

  test('a latency budget breach triggers the Devin alert', async () => {
    ARCHIVE_INDEX_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    const result = await searchObituaries({
      ...VALID, devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: '',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const payload = createSessionAndAlert.mock.calls[0][0];
    expect(payload.errorType).toBe('LatencyBudgetExceeded');
    expect(payload.issueTitle).toMatch(/^LatencyBudgetExceeded: POST \/api\/485ddc93\/obituary-search took \d+ms \(budget 1ms\)$/);
    expect(payload.culprit).toBe('app/services/verticals/485ddc93.js — searchArchiveRegions');
    expect(payload.customer).toBe('485ddc93');
    expect(payload.devinUserId).toBe('user-1');
    expect(payload.devinOrgId).toBe('org-1');
    expect(payload.promptAppendix).toContain('searchArchiveRegions');
    expect(payload.extra.regionsQueried).toBe(REGIONS.length);
  });
});
