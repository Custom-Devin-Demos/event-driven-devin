/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/services/slack', () => ({
  postThreadReply: jest.fn().mockResolvedValue('reply-ts'),
}));
jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(), recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { postThreadReply } = require('../app/services/slack');
const { Sentry } = require('../app/telemetry/sentry');
const verticalRouter = require('../app/routes/verticals/77560b41');
const {
  REGIONS,
  CATALOG,
  ORDERS_TODAY,
  getDeliveryWindows,
  getOpsSummary,
  checkout,
  groupIncident,
  reportCheckoutFailure,
  resetIncidentState,
} = require('../app/services/verticals/77560b41');

const originalSlackToken = process.env.SLACK_BOT_TOKEN;
const originalSlackChannel = process.env.SLACK_CHANNEL_ID;
let server;
let baseUrl;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const requestOptions = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    const outgoing = http.request(`${baseUrl}${urlPath}`, requestOptions, (response) => {
      let responseBody = '';
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: responseBody ? JSON.parse(responseBody) : null,
      }));
    });
    outgoing.on('error', reject);
    if (body) outgoing.write(JSON.stringify(body));
    outgoing.end();
  });
}

async function firstWindow(region) {
  return getDeliveryWindows(region)[0];
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.requestId = 'misfits-test-request';
    next();
  });
  app.use(verticalRouter);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  if (originalSlackToken === undefined) delete process.env.SLACK_BOT_TOKEN;
  else process.env.SLACK_BOT_TOKEN = originalSlackToken;
  if (originalSlackChannel === undefined) delete process.env.SLACK_CHANNEL_ID;
  else process.env.SLACK_CHANNEL_ID = originalSlackChannel;
  server.close(done);
});

beforeEach(() => {
  resetIncidentState();
  createSessionAndAlert.mockClear().mockResolvedValue(null);
  postThreadReply.mockClear();
  Sentry.captureException.mockClear();
  delete process.env.SLACK_BOT_TOKEN;
  delete process.env.SLACK_CHANNEL_ID;
});

describe('Misfits Market catalog and checkout', () => {
  test('NJ default box succeeds with the checkout payload shape', async () => {
    const window = await firstWindow('nj-pa-ny');
    const response = await request('POST', '/api/77560b41/checkout', {
      region: 'nj-pa-ny',
      items: [{ sku: 'honeycrisp-apples', qty: 1 }, { sku: 'rainbow-carrots', qty: 2 }],
      deliveryWindowId: window.id,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      region: 'nj-pa-ny',
      items: [
        { sku: 'honeycrisp-apples', qty: 1, unitPriceCents: 699 },
        { sku: 'rainbow-carrots', qty: 2, unitPriceCents: 399 },
      ],
      deliveryWindow: { id: window.id },
      totals: { subtotalCents: 1497, deliveryCents: 599, totalCents: 2096, currency: 'USD' },
    });
    expect(response.body.orderId).toMatch(/^MM-[A-F0-9]{8}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('Texas orders succeed', async () => {
    const response = await request('POST', '/api/77560b41/checkout', {
      region: 'texas',
      items: [{ sku: 'organic-eggs', qty: 1 }],
      deliveryWindowId: (await firstWindow('texas')).id,
    });
    expect(response.status).toBe(200);
    expect(response.body.items[0]).toMatchObject({ sku: 'organic-eggs', name: 'Pasture-Raised Eggs' });
  });

  test('Chicago orders without honeycrisp succeed', async () => {
    const response = await request('POST', '/api/77560b41/checkout', {
      region: 'chicago',
      items: [{ sku: 'rainbow-carrots', qty: 1 }],
      deliveryWindowId: (await firstWindow('chicago')).id,
    });
    expect(response.status).toBe(200);
    expect(response.body.items[0].sku).toBe('rainbow-carrots');
  });

  test.each([
    [{ region: 'unknown', items: [{ sku: 'gala-apples', qty: 1 }], deliveryWindowId: 'x' }, 'UNKNOWN_REGION'],
    [{ region: 'nj-pa-ny', items: [], deliveryWindowId: 'x' }, 'EMPTY_BOX'],
    [{ region: 'nj-pa-ny', items: [{ sku: 'mystery', qty: 1 }], deliveryWindowId: 'x' }, 'UNKNOWN_SKU'],
    [{ region: 'nj-pa-ny', items: [{ sku: 'gala-apples', qty: 21 }], deliveryWindowId: 'x' }, 'INVALID_QUANTITY'],
    [{ region: 'nj-pa-ny', items: [{ sku: 'gala-apples', qty: 1 }], deliveryWindowId: 'not-a-window' }, 'UNKNOWN_DELIVERY_WINDOW'],
  ])('returns structured validation error %s', async (payload, code) => {
    const response = await request('POST', '/api/77560b41/checkout', payload);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      errorClass: 'ValidationError',
      code,
      requestId: 'misfits-test-request',
    });
  });

  test('catalog returns warehouse-aware stock states and seeded Chicago orders are failed', async () => {
    const response = await request('GET', '/api/77560b41/catalog?region=chicago');
    const honeycrisp = response.body.catalog.find((item) => item.sku === 'honeycrisp-apples');
    expect(response.status).toBe(200);
    expect(honeycrisp.stockStatus).toBe('out_of_stock');
    expect(honeycrisp.stockStatusByRegion['nj-pa-ny']).toBe('in_stock');
    expect(ORDERS_TODAY).toHaveLength(120);
    const failed = ORDERS_TODAY.filter((order) => order.status === 'checkout_failed');
    expect(failed.length).toBeGreaterThanOrEqual(20);
    expect(failed.length).toBeLessThanOrEqual(25);
    expect(failed.every((order) => order.region === 'chicago'
      && order.items.some((item) => item.sku === 'honeycrisp-apples'))).toBe(true);
  });

  test('delivery windows respect the local evening cutoff', () => {
    const beforeCutoff = getDeliveryWindows('nj-pa-ny', new Date('2026-04-01T23:59:00.000Z'));
    const afterCutoff = getDeliveryWindows('nj-pa-ny', new Date('2026-04-02T00:01:00.000Z'));
    expect(beforeCutoff).toHaveLength(9);
    expect(beforeCutoff[0].date).toBe('2026-04-02');
    expect(afterCutoff[0].date).toBe('2026-04-03');
    expect(beforeCutoff.every((window) => window.cutoffLabel.includes('20:00'))).toBe(true);
  });

  test('ops summary includes seeded failures and live confirmed orders', async () => {
    const before = getOpsSummary();
    expect(before.kpis.failedCheckouts).toBe(22);
    expect(before.ordersByRegion.find((row) => row.region === 'chicago')).toMatchObject({
      checkout_failed: 22,
    });
    const window = await firstWindow('nj-pa-ny');
    await checkout({
      region: 'nj-pa-ny',
      items: [{ sku: 'gala-apples', qty: 1 }],
      deliveryWindowId: window.id,
    });
    const after = getOpsSummary();
    expect(after.kpis.ordersToday).toBe(before.kpis.ordersToday + 1);
    expect(after.ordersByRegion.find((row) => row.region === 'nj-pa-ny').confirmed)
      .toBe(before.ordersByRegion.find((row) => row.region === 'nj-pa-ny').confirmed + 1);
  });

  test('delivery regions and catalog cover every configured warehouse', () => {
    expect(Object.values(REGIONS).map((region) => region.warehouseId)).toEqual([
      'WH-NJ-DELANCO', 'WH-IL-ROMEOVILLE', 'WH-TX-DALLAS',
    ]);
    expect(CATALOG).toHaveLength(12);
  });
});

describe('Misfits Market instant alert grouping', () => {
  const failureContext = {
    region: 'chicago',
    warehouseId: 'WH-IL-ROMEOVILLE',
    skus: ['rainbow-carrots'],
    orderId: 'MM-TEST-001',
    requestId: 'request-1',
    devinUserId: 'user-1',
    devinOrgId: 'org-1',
    devinEmail: 'demo@example.com',
  };

  test('first failure alerts, repeats within thirty minutes group, later failures alert again', () => {
    const first = groupIncident({ errorClass: 'TypeError', culprit: 'applySubstitutions', region: 'chicago', now: 1000 });
    const repeat = groupIncident({ errorClass: 'TypeError', culprit: 'applySubstitutions', region: 'chicago', now: 1000 + 60000 });
    const later = groupIncident({ errorClass: 'TypeError', culprit: 'applySubstitutions', region: 'chicago', now: 1000 + 31 * 60000 });
    expect(first).toMatchObject({ isNew: true, occurrenceCount: 1 });
    expect(repeat).toMatchObject({ isNew: false, occurrenceCount: 2 });
    expect(later).toMatchObject({ isNew: true, occurrenceCount: 1 });
  });

  test('failure reporter sends the alert once for a new incident and not for grouped repeats', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'sku')");
    reportCheckoutFailure(error, { ...failureContext, now: 1000 });
    reportCheckoutFailure(error, { ...failureContext, now: 1000 + 60000, orderId: 'MM-TEST-002' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
  });

  test('failure after the grouping window triggers another alert', () => {
    const error = new TypeError('synthetic checkout failure');
    reportCheckoutFailure(error, { ...failureContext, now: 1000 });
    reportCheckoutFailure(error, { ...failureContext, now: 1000 + 31 * 60000 });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('alert payload carries Misfits routing, region context, and remediation steps', () => {
    const error = new TypeError('synthetic checkout failure');
    reportCheckoutFailure(error, failureContext);
    const [alert] = createSessionAndAlert.mock.calls[0];
    expect(alert).toMatchObject({
      customer: '77560b41',
      verticalLabel: 'Misfits Market Checkout',
      service: 'customer-77560b41-checkout',
      culprit: 'app/services/verticals/77560b41.js — applySubstitutions',
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: 'demo@example.com',
    });
    expect(alert.promptAppendix).toContain('ORDERS_TODAY');
    expect(alert.promptAppendix).toContain('tests/77560b41-checkout.test.js');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/77560b41/checkout' },
      { key: 'region', value: 'chicago' },
      { key: 'warehouse', value: 'WH-IL-ROMEOVILLE' },
    ]));
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
  });
});
