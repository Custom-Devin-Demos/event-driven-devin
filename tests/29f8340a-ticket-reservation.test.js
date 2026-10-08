/* global describe, expect, test, jest, afterEach */

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

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const ticketRoutes = require('../app/routes/verticals/29f8340a');
const {
  reserveTickets,
  resolvePass,
  buildReservation,
  PASS_CATALOGUE,
  ATTENDEE_TYPES,
  OWNER,
  SERVICE,
  ROUTE,
} = require('../app/services/verticals/29f8340a');

const IDENTITY = {
  devinUserId: OWNER.devinUserId,
  devinOrgId: OWNER.devinOrgId,
};

function postReservation(body) {
  const app = express();
  app.use(express.json());
  app.use(ticketRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: ROUTE,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
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

async function withBrokenPass(fn) {
  const pass = PASS_CATALOGUE['stack26-early-bird'];
  const { pricing } = pass;
  delete pass.pricing;
  try {
    return await fn();
  } finally {
    pass.pricing = pricing;
  }
}

afterEach(() => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('GovTech Singapore STACK Conference ticket reservation', () => {
  test('builds a reservation for a catalogued pass', () => {
    const reservation = buildReservation(
      { orderId: 'ord123', quantity: 2 },
      PASS_CATALOGUE['stack26-standard'],
      ATTENDEE_TYPES.student,
    );
    expect(reservation.passCode).toBe('stack26-standard');
    expect(reservation.pricing.unitAmountCents).toBe(34900);
    expect(reservation.pricing.totalAmountCents).toBe(34900);
    expect(reservation.access.days).toHaveLength(2);
    expect(reservation.fulfilment.transferable).toBe(true);
  });

  test('the homepage CTA reserves the default early bird pass (regression: STACK26-EARLYBIRD missed PASS_CATALOGUE)', async () => {
    const response = await postReservation({ action: 'Get your tickets', quantity: 1, ...IDENTITY });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.referenceNumber).toMatch(/^STK-/);
    expect(response.body.reservation.passCode).toBe('stack26-early-bird');
    expect(response.body.reservation.passLabel).toBe('Early bird pass');
    expect(response.body.reservation.pricing.totalAmountCents).toBe(24900);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the route default pass code resolves against the catalogue', () => {
    expect(resolvePass(ticketRoutes.DEFAULT_PASS_CODE)).toBe(PASS_CATALOGUE['stack26-early-bird']);
  });

  test.each([
    ['STACK26-EARLYBIRD', 'stack26-early-bird'],
    ['stack26-early-bird', 'stack26-early-bird'],
    ['  Stack26_Early_Bird  ', 'stack26-early-bird'],
    ['STACK26 STANDARD', 'stack26-standard'],
    ['stack26workshopaddon', 'stack26-workshop-addon'],
  ])('pass code %p resolves to %p regardless of case and separators', (input, expected) => {
    expect(resolvePass(input).code).toBe(expected);
  });

  test.each([undefined, null, '', '   ', 42, 'STACK25-EARLYBIRD'])(
    'unknown pass code %p is rejected with a 400 instead of a TypeError',
    async (passCode) => {
      expect(resolvePass(passCode)).toBeUndefined();
      await expect(reserveTickets({ action: 'Get your tickets', passCode })).rejects.toMatchObject({
        name: 'UnknownPassCodeError',
        code: 'UNKNOWN_PASS_CODE',
        statusCode: 400,
      });
    },
  );

  test('the route returns 400 UNKNOWN_PASS_CODE for an unknown pass and raises no alert', async () => {
    const response = await postReservation({ action: 'Get your tickets', passCode: 'STACK25-EARLYBIRD', ...IDENTITY });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
    expect(response.body.code).toBe('UNKNOWN_PASS_CODE');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('client-supplied Devin IDs cannot override the pinned owner', async () => {
    const response = await withBrokenPass(() => postReservation({
      action: 'Get your tickets',
      devinUserId: 'clerk-user_attacker',
      devinOrgId: 'org-attacker',
    }));

    expect(response.status).toBe(500);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('29f8340a');
    expect(alert.service).toBe(SERVICE);
    expect(alert.slackMemberId).toBe('U08S7AVJ478');
    expect(alert.devinUserId).toBe(OWNER.devinUserId);
    expect(alert.devinOrgId).toBe(OWNER.devinOrgId);
    expect(alert.errorType).toBe('TypeError');
  });

  test('every click reserves the same pass regardless of label', async () => {
    const labels = ['About us', 'Explore our products', 'Who we are', 'Privacy Statement'];
    for (const action of labels) {
      const response = await postReservation({ action, ...IDENTITY });
      expect(response.status).toBe(200);
      expect(response.body.reservation.passCode).toBe('stack26-early-bird');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a catalogued pass code reserves successfully', async () => {
    const result = await reserveTickets({
      action: 'Secure your spot', passCode: 'stack26-early-bird', attendeeType: 'public-officer', quantity: 3,
    });
    expect(result.success).toBe(true);
    expect(result.reservation.passLabel).toBe('Early bird pass');
    expect(result.reservation.pricing.totalAmountCents).toBe(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the sliding-window cap rejects with 429 once exhausted', () => {
    const { reserveReportSlot } = ticketRoutes;
    const base = Date.now() + 60 * 60 * 1000;
    let accepted = 0;
    for (let i = 0; i < 25; i += 1) {
      if (reserveReportSlot(base + i)) accepted += 1;
    }
    expect(accepted).toBeLessThanOrEqual(10);
    expect(reserveReportSlot(base + 11 * 60 * 1000)).toBe(true);
  });

  test('Retry-After reflects the remaining window rather than the full window', () => {
    const { retryAfterSeconds } = ticketRoutes;
    const base = Date.now() + 2 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i += 1) ticketRoutes.reserveReportSlot(base + i);
    expect(retryAfterSeconds(base + 9 * 60 * 1000 + 59 * 1000)).toBe(1);
    expect(retryAfterSeconds(base + 5 * 60 * 1000)).toBe(300);
    expect(ticketRoutes.reserveReportSlot(base + 11 * 60 * 1000)).toBe(true);
  });

  test('oversized or non-string actions are clamped before reaching the incident report', () => {
    const { clampAction } = ticketRoutes;
    expect(clampAction('x'.repeat(500))).toHaveLength(120);
    expect(clampAction({ nested: true })).toBe('Get your tickets');
    expect(clampAction('   ')).toBe('Get your tickets');
  });

  test('the Sentry capture carries the instant-path tag so the webhook skips it', async () => {
    await withBrokenPass(() => postReservation({ action: 'Get your tickets', ...IDENTITY }));

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, context] = Sentry.captureException.mock.calls[0];
    expect(context.tags.alert_path).toBe('instant');

    const webhookTags = Object.entries(context.tags).map(([key, value]) => ({ key, value }));
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'buildReservation', tags: webhookTags })).toBe(true);
  });

  test('tagless issue webhooks for this vertical are matched on the culprit module path', () => {
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'app/services/verticals/29f8340a.js in buildReservation', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: `POST ${ROUTE}`, tags: [] })).toBe(true);
  });
});
