/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const availabilityRoutes = require('../app/routes/verticals/ef51d258');
const {
  searchAvailability,
  RATE_QUOTE_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/ef51d258');

const VALID_REQUEST = {
  destination: 'new_york',
  rooms: 1,
  adults: 2,
  ratePreference: 'best_available',
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'jordan.lee@sterlingmedia.example',
};

const ORIGINAL_POLICY = {
  concurrency: RATE_QUOTE_POLICY.concurrency,
  latencyMs: [...RATE_QUOTE_POLICY.latencyMs],
};
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

function postRequest(body) {
  const app = express();
  app.use(express.json());
  app.use(availabilityRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/ef51d258/availability',
          method: 'POST',
          headers,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  RATE_QUOTE_POLICY.concurrency = ORIGINAL_POLICY.concurrency;
  RATE_QUOTE_POLICY.latencyMs = [...ORIGINAL_POLICY.latencyMs];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('IHG availability search — award pricing', () => {
  test('returns award stays quickly without triggering an alert', async () => {
    LATENCY_SLO.budgetMs = 3000;

    const result = await searchAvailability({
      ...VALID_REQUEST,
      ratePreference: 'points',
    });
    await tick();

    expect(result.success).toBe(true);
    expect(result.searchId).toMatch(/^IHG-[0-9A-F]{8}$/);
    expect(result.ratePreference.key).toBe('points');
    expect(result.nights).toBe(3);
    expect(result.hotels).toHaveLength(10);
    expect(result.hotels[0].nightlyRatesUsd).toBeNull();
    expect(result.hotels[0].totalUsd).toBeNull();
    expect(result.hotels[0].totalPoints).toBe(result.hotels[0].pointsPerNight * 3);
    expect(result.durationMs).toBeLessThan(result.durationMs + LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('IHG availability search — latency budget breach', () => {
  test('returns 200 success for the default search and schedules a latency alert', async () => {
    RATE_QUOTE_POLICY.latencyMs = [5, 10];
    LATENCY_SLO.budgetMs = 60;

    const { status, body } = await postRequest(VALID_REQUEST);
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.searchId).toMatch(/^IHG-[0-9A-F]{8}$/);
    expect(body.destination).toEqual({ key: 'new_york', label: 'New York, NY, United States' });
    expect(body.nights).toBe(3);
    expect(body.ratePreference).toEqual({ key: 'best_available', label: 'Best Flexible Rate' });
    expect(body.currency).toBe('USD');
    expect(body.hotels).toHaveLength(10);
    expect(body.hotels[0].nightlyRatesUsd).toHaveLength(3);
    expect(body.hotels[0].avgNightlyUsd).toBeGreaterThan(0);
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('ef51d258');
    expect(alert.service).toBe('customer-ef51d258-hotel-search');
    expect(alert.culprit).toBe('app/services/verticals/ef51d258.js — quoteNightlyRates');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/ef51d258/availability' },
      { key: 'service', value: 'customer-ef51d258-hotel-search' },
      { key: 'destination', value: 'new_york' },
      { key: 'rate_preference', value: 'best_available' },
    ]));
  });
});

describe('IHG availability search — raised rate-quote concurrency', () => {
  test('stays under budget at the sanctioned concurrency and does not alert', async () => {
    RATE_QUOTE_POLICY.latencyMs = [5, 10];
    RATE_QUOTE_POLICY.concurrency = 16;
    LATENCY_SLO.budgetMs = 60;

    const { status, body } = await postRequest(VALID_REQUEST);
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeLessThanOrEqual(LATENCY_SLO.budgetMs);
    expect(body.hotels).toHaveLength(10);
    expect(body.hotels[0].nightlyRatesUsd).toHaveLength(3);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('IHG availability search validation', () => {
  test('rejects a missing destination with a 400 and no alert', async () => {
    const { status, body } = await postRequest({ ...VALID_REQUEST, destination: undefined });
    await tick();

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('SEARCH_DETAILS_INVALID');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
