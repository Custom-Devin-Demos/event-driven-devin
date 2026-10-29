/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/oncall', () => ({
  postOncallAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { postOncallAlert } = require('../app/services/oncall');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const checkoutRoutes = require('../app/routes/verticals/0875ddd9');
const { SERVICE, ROUTE, ENTITLEMENT_CATALOG, EDITION_ENTITLEMENTS } = require('../app/services/verticals/0875ddd9');

const EMAIL = 'mypark.hooper@example.com';

function postOrder(body) {
  const app = express();
  app.use(express.json());
  app.use(checkoutRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: ROUTE,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

afterEach(() => {
  postOncallAlert.mockClear();
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('2K Store checkout (0875ddd9)', () => {
  test('the pre-filled NBA 2K27 Standard Edition order fails downstream and pages on-call instead of the automated alert', async () => {
    const response = await postOrder({
      title: 'nba-2k27', edition: 'standard', platform: 'ps5', email: EMAIL,
      devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: 'se@example.com',
    });

    expect(response.status).toBe(500);
    expect(response.body.errorClass).toBe('TypeError');
    expect(response.body.error).toMatch(/reading 'vcAmount'/);

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(postOncallAlert).toHaveBeenCalledTimes(1);
    const [scenarioId, alert] = postOncallAlert.mock.calls[0];
    expect(scenarioId).toBe('0875ddd9');
    expect(alert.devinEmail).toBe('se@example.com');
    expect(alert.devinUserId).toBe('user-1');
    expect(alert.devinOrgId).toBe('org-1');

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const sentryContext = JSON.stringify(Sentry.captureException.mock.calls[0][1]);
    expect(sentryContext).not.toContain(EMAIL);
    expect(JSON.stringify(alert)).not.toContain(EMAIL);
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/0875ddd9.js', tags: [] })).toBe(true);
  });

  test('an empty body defaults to the failing hero order', async () => {
    const response = await postOrder({ email: EMAIL });
    expect(response.status).toBe(500);
    expect(response.body.errorClass).toBe('TypeError');
  });

  test.each([
    ['nba-2k27', 'deluxe'],
    ['nba-2k27', 'ultra'],
    ['wwe-2k26', 'standard'],
    ['borderlands-4', 'deluxe'],
    ['civilization-vii', 'standard'],
  ])('%s %s completes successfully', async (title, edition) => {
    const response = await postOrder({ title, edition, platform: 'steam', email: EMAIL });
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.orderId).toMatch(/^2KS-[0-9A-F]{8}$/);
    expect(postOncallAlert).not.toHaveBeenCalled();
  });

  test('NBA 2K27 Ultra Edition grants 100,000 VC', async () => {
    const response = await postOrder({ title: 'nba-2k27', edition: 'ultra', platform: 'ps5', email: EMAIL });
    expect(response.body.vcGranted).toBe(100000);
  });

  test('invalid input is rejected with 400 and no alert', async () => {
    const response = await postOrder({ title: 'nba-2k27', edition: 'standard', platform: 'ps5', email: 'nope' });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_EMAIL');
    expect(postOncallAlert).not.toHaveBeenCalled();
  });

  test('the only uncatalogued entitlement is the Standard Edition Season 2 bonus', () => {
    const missing = Object.entries(EDITION_ENTITLEMENTS)
      .flatMap(([sku, entitlements]) => entitlements.filter((e) => !ENTITLEMENT_CATALOG[e]).map((e) => `${sku}:${e}`));
    expect(missing).toEqual(['nba-2k27:standard:nba2k27-s2-locker-code-vc']);
  });
});

describe('2K Store on-call scenario', () => {
  test('is registered for the on-call handler and kept off the hub', () => {
    const { ALERT_SCENARIOS } = jest.requireActual('../app/services/oncall');
    const scenario = ALERT_SCENARIOS['0875ddd9'];
    expect(scenario.service).toBe(SERVICE);
    expect(scenario.endpoint).toBe(`POST ${ROUTE}`);
    expect(scenario.demoPage).toBe('/0875ddd9');
    expect(scenario.unlisted).toBe(true);
  });
});
