/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => {
  const { currentAlertDestination } = jest.requireActual('../app/services/alert-destination');
  return {
    createSessionAndAlert: jest.fn((alert) => {
      alert.alertDestination = currentAlertDestination();
      return Promise.resolve({ ok: true });
    }),
  };
});

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue(null),
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
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { runWithAlertDestination } = require('../app/services/alert-destination');
const bookingRoutes = require('../app/routes/verticals/3503d9e5');
const {
  getFlightSearch, computeFareBreakdown, processBooking, DEFAULT_BOOKING, SERVICE, ROUTE, INCIDENT_COOLDOWN_MS,
} = require('../app/services/verticals/3503d9e5');

const TRAVELER = { firstName: 'Jordan', lastName: 'Lee' };
const PAYMENT = { brand: 'Visa', cardLast4: '1111' };

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(bookingRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body ? JSON.stringify(body) : '';
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
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
      req.on('error', (err) => server.close(() => reject(err)));
      req.end(payload);
    });
  });
}

function book(overrides) {
  return request('POST', ROUTE, {
    ...DEFAULT_BOOKING, traveler: TRAVELER, payment: PAYMENT, ...overrides,
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('3503d9e5 united.com booking', () => {
  test('search results price Standard and Flexible off the Basic Economy fare', async () => {
    const { status, body } = await request('GET', '/api/3503d9e5/flights');
    expect(status).toBe(200);
    const ua648 = body.outbound.find((f) => f.flightNumber === 'UA 648');
    expect(ua648.fares.economy.map((o) => [o.code, o.price])).toEqual([
      ['ECO-BASIC', 437], ['ECO-STANDARD', 567], ['ECO-FLEXIBLE', 667],
    ]);
    expect(getFlightSearch().inbound.length).toBeGreaterThan(0);
  });

  test('fare breakdown sums back to the advertised total', () => {
    const b = computeFareBreakdown(567);
    expect(Math.round((b.baseFare + b.taxesTotal) * 100) / 100).toBe(567);
  });

  test('the default Standard Economy purchase fails with a TypeError and raises exactly one alert', async () => {
    const response = await book({ devinUserId: 'user-1', devinOrgId: 'org-1', devinEmail: 'demo@devindemos.com' });
    expect(response.status).toBe(500);
    expect(response.body.success).toBe(false);
    expect(response.body.errorClass).toBe('TypeError');
    expect(response.body.error).toMatch(/reading 'carryOn'/);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('3503d9e5');
    expect(alert.service).toBe(SERVICE);
    expect(alert.devinUserId).toBe('user-1');
    expect(alert.devinOrgId).toBe('org-1');
    expect(alert.devinEmail).toBe('demo@devindemos.com');
    expect(JSON.stringify(alert.extra)).not.toMatch(/Jordan|Lee|1111/);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident.mock.calls[0][0]).toMatchObject({
      title: 'united.com booking purchase failing at ticketing',
      service: SERVICE,
      severity: 'SEV-2',
      triggeredBy: 'demo@devindemos.com',
    });
  });

  test('repeat failures inside the cooldown open only one Datadog incident', async () => {
    const later = Date.now() + INCIDENT_COOLDOWN_MS * 10;
    jest.spyOn(Date, 'now').mockReturnValue(later);
    await book();
    await book();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    Date.now.mockReturnValue(later + INCIDENT_COOLDOWN_MS);
    await book();
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
    Date.now.mockRestore();
  });

  test('the alert always routes to Microsoft Teams, even when the browser picked Slack', async () => {
    await expect(runWithAlertDestination('slack', () => processBooking({
      ...DEFAULT_BOOKING, traveler: TRAVELER, payment: PAYMENT,
    }))).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].alertDestination).toBe('teams');
  });

  test('an empty body defaults to the failing Standard itinerary', async () => {
    const response = await request('POST', ROUTE, {});
    expect(response.status).toBe(500);
    expect(response.body.errorClass).toBe('TypeError');
  });

  test('Flexible Economy tickets successfully', async () => {
    const response = await book({ fareBrand: 'ECO-FLEXIBLE' });
    expect(response.status).toBe(200);
    expect(response.body.booking.status).toBe('TICKETED');
    expect(response.body.booking.ticketNumber).toMatch(/^016\d{10}$/);
    expect(response.body.booking.confirmationNumber).toMatch(/^[A-Z2-9]{6}$/);
    expect(response.body.booking.conditions.refundable).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('Basic Economy requires the acknowledgement, then tickets', async () => {
    const rejected = await book({ fareBrand: 'ECO-BASIC' });
    expect(rejected.status).toBe(400);
    const response = await book({ fareBrand: 'ECO-BASIC', basicEconomyAck: true });
    expect(response.status).toBe(200);
    expect(response.body.booking.conditions.carryOnBags).toBe(0);
  });

  test('tagless issue webhooks for this vertical are matched on the culprit module path', () => {
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'app/services/verticals/3503d9e5.js in buildTicketingConditions', tags: [] })).toBe(true);
  });
});
