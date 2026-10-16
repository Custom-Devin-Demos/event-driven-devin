/* global describe, expect, test, jest, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
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
const { placeOrder, priceBag, datadogLogsUrl, CHECKOUT_MARKDOWNS, PRODUCT, DATADOG_LOGS_QUERY } = require('../app/services/verticals/2b43150a');
const checkoutRoutes = require('../app/routes/verticals/2b43150a');
const customer = require('../config/customers/2b43150a');

const NAVY_CHECKOUT = { variantId: '907280012', size: 'M', fit: 'Regular', quantity: 1 };
const BLACK_LINE = { styleNumber: '907280', variantId: '907280042', name: 'Relaxed Polo Sweater', color: 'True black', fit: 'Regular', size: 'M', quantity: 1, unitPrice: 79.95 };

function request(method, path, body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(checkoutRoutes);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        port: server.address().port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end(payload);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Gap product page checkout (2b43150a)', () => {
  test('customer config is an api-triggered vertical', () => {
    expect(customer).toMatchObject({ triggerMode: 'api' });
  });

  test('the new navy colorway has no checkout markdown while every other colorway does', () => {
    expect(CHECKOUT_MARKDOWNS['907280012']).toBeUndefined();
    PRODUCT.colors.filter((c) => c.variantId !== '907280012').forEach((c) => {
      expect(CHECKOUT_MARKDOWNS[c.variantId]).toMatchObject({ rate: 0.4 });
    });
  });

  test('other colorways price with the 40% Friends & Family markdown', () => {
    const pricing = priceBag([BLACK_LINE]);
    expect(pricing).toMatchObject({ merchandise: 79.95, markdown: 31.98, subtotal: 47.97, promotion: 'Friends & Family 40% off everything' });
    expect(pricing.lines[0].markdownRate).toBe(0.4);
  });

  test('checking out the navy colorway throws a TypeError and raises Sentry + the alert', async () => {
    await expect(placeOrder(NAVY_CHECKOUT)).rejects.toThrow(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toBe("TypeError: Cannot read properties of undefined (reading 'rate')");
    expect(alert.culprit).toBe('app/services/verticals/2b43150a.js — markdownLine');
    expect(alert.verticalLabel).toBe('Gap — Relaxed Polo Sweater checkout');
    expect(alert.customer).toBe('2b43150a');
    expect(alert.service).toBe('customer-gap-pdp-checkout');
  });

  test('the alert links the View Datadog button to this service\'s error logs', async () => {
    await expect(placeOrder(NAVY_CHECKOUT)).rejects.toThrow(TypeError);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.datadogUrl).toContain('/logs?query=');
    expect(decodeURIComponent(alert.datadogUrl)).toContain(DATADOG_LOGS_QUERY);
    expect(alert.promptAppendix).toContain(DATADOG_LOGS_QUERY);
  });

  test('POST /api/2b43150a/checkout returns a 500 with a request id', async () => {
    const res = await request('POST', '/api/2b43150a/checkout', NAVY_CHECKOUT);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'CHECKOUT_FAILED' });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  test('POST /api/2b43150a/checkout places an order for another colorway', async () => {
    const res = await request('POST', '/api/2b43150a/checkout', { ...NAVY_CHECKOUT, variantId: '907280042' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: 'placed' });
    expect(res.body.pricing.markdown).toBe(31.98);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reproduction requests fail identically without alerting', async () => {
    const res = await request('POST', '/api/2b43150a/checkout', NAVY_CHECKOUT, { 'x-synthetic': '1' });
    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('unknown variants, missing sizes and bad quantities are handled 400s with no alert', async () => {
    const unknownVariant = await request('POST', '/api/2b43150a/checkout', { ...NAVY_CHECKOUT, variantId: '907280999' });
    const noSize = await request('POST', '/api/2b43150a/checkout', { ...NAVY_CHECKOUT, size: '' });
    expect(unknownVariant.status).toBe(400);
    expect(noSize.status).toBe(400);
    for (const quantity of [0, 11, 2.9, '2garbage', '', null, true]) {
      const res = await request('POST', '/api/2b43150a/checkout', { ...NAVY_CHECKOUT, quantity });
      expect([quantity, res.status, res.body.code]).toEqual([quantity, 400, 'INVALID_QUANTITY']);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a multi-line bag is priced as one order and every line is returned', async () => {
    const lines = [
      { variantId: '907280042', size: 'M', fit: 'Regular', quantity: 2 },
      { variantId: '907280052', size: 'L', fit: 'Tall', quantity: '1' },
    ];
    const res = await request('POST', '/api/2b43150a/checkout', { lines });
    expect(res.status).toBe(200);
    expect(res.body.pricing.lines).toHaveLength(2);
    expect(res.body.pricing.lines.map((l) => [l.variantId, l.quantity])).toEqual([['907280042', 2], ['907280052', 1]]);
    expect(res.body.pricing).toMatchObject({ merchandise: 239.85, markdown: 95.94, subtotal: 143.91, shipping: 0 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a multi-line bag that includes the navy colorway fails as one checkout with one alert', async () => {
    const lines = [
      { variantId: '907280042', size: 'M', fit: 'Regular', quantity: 1 },
      { variantId: '907280012', size: 'L', fit: 'Regular', quantity: 1 },
    ];
    const res = await request('POST', '/api/2b43150a/checkout', { lines });
    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0].extra.variantId).toBe('907280042,907280012');
    const empty = await request('POST', '/api/2b43150a/checkout', { lines: [] });
    expect(empty.status).toBe(400);
  });

  test('the Datadog link targets the app host of the configured site', () => {
    const original = process.env.DD_SITE;
    process.env.DD_SITE = 'us5.datadoghq.com';
    expect(datadogLogsUrl()).toMatch(/^https:\/\/app\.us5\.datadoghq\.com\/logs\?query=/);
    delete process.env.DD_SITE;
    expect(datadogLogsUrl()).toMatch(/^https:\/\/app\.datadoghq\.com\/logs\?query=/);
    if (original === undefined) delete process.env.DD_SITE; else process.env.DD_SITE = original;
  });

  test('GET /api/2b43150a/product returns the product and the promotion', async () => {
    const res = await request('GET', '/api/2b43150a/product');
    expect(res.status).toBe(200);
    expect(res.body.product.name).toBe('Relaxed Polo Sweater');
    expect(res.body.product.colors).toHaveLength(6);
    expect(res.body.promotion.code).toBe('FAMILY');
  });
});

describe('sentry webhook dedupe (2b43150a)', () => {
  test('checkout failures are recognised as instant-path events', () => {
    const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/2b43150a.js — markdownLine', tags: [] })).toBe(true);
  });

  test('the captured event carries alert_path: instant', async () => {
    await expect(placeOrder(NAVY_CHECKOUT)).rejects.toThrow(TypeError);
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
  });
});
