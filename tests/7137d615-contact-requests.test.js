/* global afterAll, afterEach, beforeAll, beforeEach, describe, expect, fetch, jest, test, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const express = require('express');
const router = require('../app/routes/verticals/7137d615');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { incrementMetric, recordTiming } = require('../app/telemetry/datadog');
const { Sentry } = require('../app/telemetry/sentry');
const {
  PRODUCTS, PREFILL, LATENCY_SLO, DESK_LOOKUP, LOAN_DESKS,
} = require('../app/services/verticals/7137d615');

const PATH = '/api/7137d615';
const REQUEST_ID = /^OCT-[0-9A-F]{8}$/;
const originalBudget = LATENCY_SLO.budgetMs;
const originalDelay = DESK_LOOKUP.latencyMs;
let server;
let baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}${PATH}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  DESK_LOOKUP.latencyMs = 4;
});

afterEach(() => {
  DESK_LOOKUP.latencyMs = originalDelay;
  LATENCY_SLO.budgetMs = originalBudget;
  jest.clearAllMocks();
});

async function submit(payload) {
  const response = await fetch(`${baseUrl}/contact-requests`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

describe('Octaura Contact Us', () => {
  test('serves the prefill and successfully routes Loan trading with 14 results in order', async () => {
    const config = await fetch(`${baseUrl}/config`);
    expect(config.status).toBe(200);
    expect(await config.json()).toEqual({
      success: true, products: PRODUCTS, prefill: PREFILL, budgetMs: 3000,
    });

    const { status, body } = await submit(PREFILL);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      requestId: expect.stringMatching(REQUEST_ID),
      request: {
        status: 'submitted',
        products: ['loan-trading'],
        routedTo: 'US Syndicated Loans',
        desks: LOAN_DESKS.map((name) => ({ name, available: name !== 'Distressed Credit' })),
      },
      timing: { budgetMs: 3000, desksChecked: 14 },
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [['clo-trading'], 'CLO Trading'],
    [['data-analytics'], 'Data & Analytics'],
    [['clo-trading', 'data-analytics'], 'CLO Trading'],
  ])('routes %j with a single fast lookup', async (products, desk) => {
    DESK_LOOKUP.latencyMs = originalDelay;
    const { status, body } = await submit({ ...PREFILL, products });
    expect(status).toBe(200);
    expect(body.request).toMatchObject({
      products,
      routedTo: desk,
      desks: [{ name: desk, available: true }],
    });
    expect(body.timing.desksChecked).toBe(1);
    expect(body.timing.totalMs).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reports the budget breach while still returning a successful submission', async () => {
    LATENCY_SLO.budgetMs = 1;
    const presenter = { devinUserId: 'presenter', devinOrgId: 'demo-org', devinEmail: 'presenter@example.com' };
    const { status, body } = await submit({ ...PREFILL, ...presenter });
    await new Promise((resolve) => setImmediate(resolve));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const tags = { route: `${PATH}/contact-requests`, service: 'customer-7137d615-octaura-contact' };
    const extra = {
      requestId: body.requestId, durationMs: body.timing.totalMs, desksChecked: 14, budgetMs: 1,
    };
    expect(incrementMetric).toHaveBeenCalledWith('contact_request.success', tags);
    expect(recordTiming).toHaveBeenCalledWith('contact_request.latency', body.timing.totalMs, tags);
    expect(incrementMetric).toHaveBeenCalledWith('contact_request.latency_budget_breach', tags);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LatencyBudgetExceeded' }),
      { level: 'warning', tags: { ...tags, alert_path: 'latency' }, extra },
    );
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      ...presenter,
      customer: '7137d615',
      repos: ['COG-GTM/event-driven-devin'],
      skipVulnerablePr: true,
      service: tags.service,
      issueTitle: `LatencyBudgetExceeded: POST ${PATH}/contact-requests took ${body.timing.totalMs}ms (budget 1ms)`,
      culprit: 'app/services/verticals/7137d615.js — resolveContactDesk',
      promptAppendix: expect.stringContaining('Promise.all'),
      extra,
    }));
  });

  test.each([
    [{ email: 'bad-email' }, 'INVALID_EMAIL'],
    [{ company: '   ' }, 'INVALID_COMPANY'],
    [{ products: [] }, 'INVALID_PRODUCTS'],
    [{ products: ['unknown'] }, 'INVALID_PRODUCTS'],
    [{ products: ['loan-trading', 'loan-trading'] }, 'INVALID_PRODUCTS'],
    [{ consent: 'true' }, 'CONSENT_REQUIRED'],
  ])('rejects invalid fields without dispatching an alert (%#)', async (overrides, code) => {
    const { status, body } = await submit({ ...PREFILL, ...overrides });
    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: expect.any(String),
      errorClass: 'ValidationError',
      code,
      requestId: expect.stringMatching(REQUEST_ID),
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
