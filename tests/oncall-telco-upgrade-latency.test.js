/* global jest, afterAll, afterEach, beforeAll, describe, expect, test, fetch */
jest.mock('../app/telemetry/datadog', () => ({
  tracer: { init: jest.fn() },
  initDatadog: jest.fn(),
  getStatsClient: jest.fn(() => null),
  recordMetric: jest.fn(),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const logger = require('../app/telemetry/logger');
const { incrementMetric, recordTiming } = require('../app/telemetry/datadog');
const { Sentry } = require('../app/telemetry/sentry');
const { upgradePlan, PLAN_CATALOG } = require('../app/services/oncall-verticals/telco');
const routes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(30000);

const upgrade = (overrides = {}, options) => upgradePlan({
  accountId: 'CUST-3001', currentPlanCode: 'BASIC-12', targetPlanCode: 'FAMILY-PLUS-12', billingDay: 15, ...overrides,
}, options);

afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('telco plan upgrade latency', () => {
  test('latency does not scale with the plan catalog size', async () => {
    expect(PLAN_CATALOG.length).toBeGreaterThan(30);
    const started = Date.now();
    const result = await upgrade();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(result).toMatchObject({ success: true, status: 'upgraded', newPlan: 'Family Plus' });
  });

  test('tripling the catalog with legacy plans keeps the upgrade under the alert threshold', async () => {
    const originalLength = PLAN_CATALOG.length;
    PLAN_CATALOG.push(...Array.from({ length: 70 }, (_, i) => ({
      id: `LEGACY-X${i}`, name: `Extra Legacy ${i}`, monthlyRate: 15 + i, dataGB: 2, family: 'grandfathered',
    })));
    try {
      const started = Date.now();
      await expect(upgrade({ targetPlanCode: 'ULTRA-36' })).resolves.toMatchObject({ success: true });
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      PLAN_CATALOG.length = originalLength;
    }
  });

  test('evaluates exactly one migration path and records success telemetry', async () => {
    const info = jest.spyOn(logger, 'info');
    await upgrade({ targetPlanCode: 'PLUS-24' });
    expect(info).toHaveBeenCalledWith('Plan upgrade completed', expect.objectContaining({ pathsEvaluated: 1, service: 'telco-api' }));
    expect(incrementMetric).toHaveBeenCalledWith('upgrade.success', { route: '/api/oncall/telco/upgrade', targetPlan: 'PLUS-24' });
    expect(recordTiming).toHaveBeenCalledWith('upgrade.latency', expect.any(Number), { route: '/api/oncall/telco/upgrade' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('telco plan upgrade rules', () => {
  test.each([
    ['LEGACY-01', 'regional'],
    ['LEGACY-02', 'grandfathered'],
  ])('a %s (%s) target plan is rejected as ineligible', async (targetPlanCode) => {
    await expect(upgrade({ targetPlanCode })).rejects.toMatchObject({ code: 'INELIGIBLE_PLAN' });
  });

  test('a subscriber on a legacy plan can still move to a core plan', async () => {
    await expect(upgrade({ currentPlanCode: 'LEGACY-05', targetPlanCode: 'PLUS-24' }))
      .resolves.toMatchObject({ success: true, previousPlan: 'Legacy Plan 5', newPlan: 'Plus' });
  });

  test.each([
    [{ targetPlanCode: 'NOPE-99' }, /NOPE-99/],
    [{ currentPlanCode: 'GONE-01' }, /GONE-01/],
  ])('an unknown plan code is rejected (%o)', async (overrides, message) => {
    await expect(upgrade(overrides)).rejects.toMatchObject({ code: 'UNKNOWN_PLAN', message: expect.stringMatching(message) });
  });

  test('failures record failure telemetry and report to Sentry with the synthetic tag', async () => {
    await expect(upgrade({ targetPlanCode: 'LEGACY-01' }, { synthetic: true })).rejects.toThrow();
    expect(incrementMetric).toHaveBeenCalledWith('upgrade.failure', { route: '/api/oncall/telco/upgrade', errorClass: 'Error' });
    expect(recordTiming).toHaveBeenCalledWith('upgrade.latency', expect.any(Number), { route: '/api/oncall/telco/upgrade', error: 'true' });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INELIGIBLE_PLAN' }),
      expect.objectContaining({ tags: expect.objectContaining({ service: 'telco-api', targetPlan: 'LEGACY-01', synthetic_probe: 'true' }) }),
    );
  });

  test('a billing hold shorter than the request expires before commit', async () => {
    await expect(upgrade({}, { holdTtlMs: 1 })).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
  });

  test('the default 5s billing hold no longer expires', async () => {
    await expect(upgrade({}, { holdTtlMs: 5000 })).resolves.toMatchObject({ success: true });
  });
});

describe('telco plan upgrade response', () => {
  test.each([
    ['UNLIMITED-24', { newPlan: 'Unlimited', newDataGB: 'Unlimited', newTermMonths: 24, monthlyTotal: '119.99', discount: '12.00' }],
    ['FAMILY-PLUS-12', { newPlan: 'Family Plus', newDataGB: '100 GB', newTermMonths: 12, monthlyTotal: '99.99' }],
    ['PLUS-24', { newPlan: 'Plus', plan: 'Plus', newDataGB: '15 GB', newTermMonths: 24, newMonthlyRate: 49.99 }],
  ])('%s returns the plan details', async (targetPlanCode, expected) => {
    const result = await upgrade({ targetPlanCode });
    expect(result).toMatchObject({ accountId: 'CUST-3001', previousPlan: 'Basic', status: 'upgraded', ...expected });
    expect(result.upgradeId).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe('proration (today is the 10th of a 30-day month)', () => {
    const fakeToday = () => jest.useFakeTimers({
      now: new Date(2026, 10, 10, 12),
      doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask'],
    });

    test('a billing day later this month prorates the remaining days', async () => {
      fakeToday();
      const result = await upgrade({ targetPlanCode: 'ULTRA-36', billingDay: 15 });
      expect(result.prorationCharge).toBe(8.33);
      expect(result.effectiveDate).toBe('2026-11-10');
    });

    test('a billing day already passed prorates into next month', async () => {
      fakeToday();
      expect((await upgrade({ targetPlanCode: 'ULTRA-36', billingDay: 5 })).prorationCharge).toBe(41.67);
    });

    test('a downgrade yields a credit', async () => {
      fakeToday();
      expect((await upgrade({ currentPlanCode: 'ULTRA-36', targetPlanCode: 'BASIC-12', billingDay: 15 })).prorationCharge).toBe(-8.33);
    });

    test('a missing billing day defaults to the 15th', async () => {
      fakeToday();
      expect((await upgrade({ targetPlanCode: 'ULTRA-36', billingDay: undefined })).prorationCharge).toBe(8.33);
    });
  });
});

describe('POST /api/oncall/telco/upgrade', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(routes);
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => { server.close(() => stopGateway().then(() => done())); });

  const post = (body, headers = {}) => fetch(`${baseUrl}/api/oncall/telco/upgrade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

  test('an empty body upgrades the default subscriber well under 1.5s', async () => {
    const started = Date.now();
    const res = await post({});
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(await res.json()).toMatchObject({ success: true, accountId: 'CUST-3001', previousPlan: 'Basic', newPlan: 'Family Plus' });
  });

  test('plan codes are case-insensitive (One NZ skin)', async () => {
    const res = await post({ currentPlanCode: 'basic-12', targetPlanCode: 'ultra-36' }, { 'X-Oncall-Skin': 'd9cf9e97' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ newPlan: 'Ultra' });
  });

  test.each([
    ['NOPE-99', 'UNKNOWN_PLAN'],
    ['LEGACY-01', 'INELIGIBLE_PLAN'],
  ])('target %s returns 500 with code %s', async (targetPlanCode, code) => {
    const res = await post({ targetPlanCode });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, code });
  });
});
