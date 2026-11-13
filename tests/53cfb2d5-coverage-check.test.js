/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/53cfb2d5');
const {
  checkCoverage,
  selectCoverage,
  CARRIERS,
  BCBS_PLAN_DIRECTORY,
  US_STATES,
  ELIGIBILITY_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/53cfb2d5');

const ORIGINAL_LATENCY = [...ELIGIBILITY_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

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
  ELIGIBILITY_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Nourish coverage check', () => {
  test('default BCBS check asks every regional plan in directory order and finds Texas coverage', async () => {
    ELIGIBILITY_POLICY.latencyMs = [1, 3];

    const result = await checkCoverage();

    expect(result.success).toBe(true);
    expect(result.checkId).toMatch(/^NRSH-[0-9A-F]{8}$/);
    expect(result.patient).toEqual({ firstName: 'Jordan', lastName: 'Rivera', state: 'TX' });
    expect(result.carrier).toEqual({ key: 'bcbs', label: 'Blue Cross Blue Shield' });
    expect(result.plansChecked).toBe(14);
    expect(result.planResponses.map((r) => r.planId)).toEqual(BCBS_PLAN_DIRECTORY.map((p) => p.id));
    expect(result.planResponses.filter((r) => r.status === 'active').map((r) => r.planId)).toEqual(['bcbstx']);
    expect(result.covered).toBe(true);
    expect(result.coverage).toEqual(expect.objectContaining({
      planId: 'bcbstx',
      plan: 'Blue Cross and Blue Shield of Texas',
      payerId: '84980',
      copayUsd: 0,
      visitsPerYear: 12,
    }));
    expect(result.coverage.memberId).toMatch(/^BCB\d{9}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('overlapping BCBS plans resolve to the first active plan in directory order', async () => {
    ELIGIBILITY_POLICY.latencyMs = [1, 3];

    const result = await checkCoverage({ state: 'NY' });

    expect(result.planResponses.filter((r) => r.status === 'active').map((r) => r.planId))
      .toEqual(['anthem', 'highmark', 'excellus']);
    expect(result.coverage.planId).toBe('anthem');
    expect(selectCoverage([
      { planId: 'a', status: 'no_member_record' },
      { planId: 'b', status: 'active' },
      { planId: 'c', status: 'active' },
    ]).planId).toBe('b');
  });

  test.each(['aetna', 'cigna', 'uhc', 'medicare', 'humana'])('%s checks a single national plan', async (carrier) => {
    ELIGIBILITY_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/53cfb2d5/coverage-check', { carrier, state: 'CA' });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.carrier).toEqual({ key: carrier, label: CARRIERS[carrier].label });
    expect(body.plansChecked).toBe(1);
    expect(body.covered).toBe(true);
    expect(body.coverage.plan).toBe(CARRIERS[carrier].plans[0].label);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reports no coverage when no BCBS plan has a member record in the state', async () => {
    ELIGIBILITY_POLICY.latencyMs = [1, 3];

    const result = await checkCoverage({ state: 'HI' });

    expect(result.success).toBe(true);
    expect(result.covered).toBe(false);
    expect(result.coverage).toBeNull();
    expect(result.plansChecked).toBe(14);
  });

  test('returns success and schedules a latency-budget alert on breach', async () => {
    ELIGIBILITY_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/53cfb2d5/coverage-check', {
      carrier: 'aetna',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'jordan.lee@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('53cfb2d5');
    expect(alert.service).toBe('customer-53cfb2d5-coverage-check');
    expect(alert.culprit).toBe('app/services/verticals/53cfb2d5.js — collectPlanEligibility');
    expect(alert.verticalLabel).toBe('Nourish Coverage Check');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.promptAppendix).toContain('collectPlanEligibility');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/53cfb2d5/coverage-check' },
      { key: 'service', value: 'customer-53cfb2d5-coverage-check' },
      { key: 'carrier', value: 'aetna' },
      { key: 'state', value: 'TX' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.checkId,
      durationMs: body.durationMs,
      budgetMs: 1,
      plansChecked: 1,
    }));
  });

  test('rejects invalid coverage details through the route', async () => {
    const invalidRequests = [
      { firstName: '' },
      { lastName: '123' },
      { dateOfBirth: '1988-02-30' },
      { dateOfBirth: '2999-01-01' },
      { state: 'ZZ' },
      { carrier: 'unknown' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/53cfb2d5/coverage-check', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('COVERAGE_DETAILS_INVALID');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns carrier and state metadata', async () => {
    const { status, body } = await request('GET', '/api/53cfb2d5/carriers');

    expect(status).toBe(200);
    expect(body.carriers).toEqual(Object.entries(CARRIERS).map(([key, carrier]) => ({
      key,
      label: carrier.label,
      planCount: carrier.plans.length,
    })));
    expect(body.states).toEqual(US_STATES);
  });
});
