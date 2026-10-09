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
const { placeOrder, STORES, DELIVERY_FEE_SCHEDULES } = require('../app/services/verticals/59c53533');
const dgRoutes = require('../app/routes/verticals/59c53533');
const dgCustomer = require('../config/customers/59c53533');

const PREFILLED_CART = [
  { sku: '00931504', qty: 1 },
  { sku: '01908001', qty: 1 },
  { sku: '40014501', qty: 1 },
  { sku: '00931004', qty: 1 },
];

function request(method, path, body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(dgRoutes);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path,
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

describe('Dollar General Same Day Delivery checkout (59c53533)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('customer config exposes /dollar-general and /dg', () => {
    expect(dgCustomer.aliases).toEqual(['dollar-general', 'dg']);
    expect(dgCustomer.triggerMode).toBe('api');
  });

  test('the new wave 7 store has no delivery fee schedule (planted bug)', () => {
    expect(STORES['13942'].deliveryZone).toBe('TN-NASH-07');
    expect(DELIVERY_FEE_SCHEDULES['TN-NASH-07']).toBeUndefined();
    expect(DELIVERY_FEE_SCHEDULES[STORES['08715'].deliveryZone]).toBeDefined();
  });

  test('delivery from store 13942 fails with a TypeError and alerts for this customer', async () => {
    const res = await request('POST', '/api/dollar-general/checkout', {
      items: PREFILLED_CART,
      fulfillment: 'delivery',
      storeId: '13942',
      devinUserId: 'user-test',
      devinOrgId: 'org-test',
    });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      success: false,
      errorClass: 'TypeError',
      code: 'CHECKOUT_FAILED',
      error: "Cannot read properties of undefined (reading 'baseFee')",
    });
    expect(res.body.requestId).toEqual(expect.any(String));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: '59c53533',
      service: 'customer-dollar-general-checkout',
      devinUserId: 'user-test',
      devinOrgId: 'org-test',
      culprit: 'app/services/verticals/59c53533.js — applyMyDgFreeDelivery',
    });
    expect(alert.extra).toMatchObject({ storeNumber: '13942', deliveryZone: 'TN-NASH-07', fulfillment: 'delivery' });
    expect(alert.tags).toEqual(expect.arrayContaining([{ key: 'route', value: '/api/dollar-general/checkout' }]));
    expect(alert.promptAppendix).toContain('POST /api/dollar-general/checkout');
    expect(alert.promptAppendix).toContain('/dollar-general?repro=1');
  });

  test('reproduction requests fail identically without Sentry or a Devin session', async () => {
    const res = await request('POST', '/api/dollar-general/checkout', {
      items: PREFILLED_CART,
      fulfillment: 'delivery',
      storeId: '13942',
    }, { 'x-synthetic': '1' });

    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('store pickup from store 13942 succeeds', async () => {
    const res = await request('POST', '/api/dollar-general/checkout', {
      items: PREFILLED_CART,
      fulfillment: 'pickup',
      storeId: '13942',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      fulfillment: 'pickup',
      subtotal: 21.75,
      deliveryFee: 0,
      tax: 2.01,
      total: 23.76,
    });
    expect(res.body.orderNumber).toMatch(/^DG\d{9}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('delivery from an established store applies the myDG free delivery', async () => {
    const res = await request('POST', '/api/dollar-general/checkout', {
      items: PREFILLED_CART,
      fulfillment: 'delivery',
      storeId: '08715',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      fulfillment: 'delivery',
      baseFee: 6.95,
      myDgDiscount: 6.95,
      deliveryFee: 0,
      usedFreeDelivery: true,
      total: 23.76,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [{ items: [], fulfillment: 'delivery', storeId: '13942' }, 'EMPTY_CART'],
    [{ items: PREFILLED_CART, fulfillment: 'drone', storeId: '13942' }, 'INVALID_ORDER'],
    [{ items: PREFILLED_CART, fulfillment: 'delivery', storeId: '99999' }, 'INVALID_ORDER'],
    [{ items: [{ sku: 'NOPE', qty: 1 }], fulfillment: 'pickup', storeId: '13942' }, 'INVALID_ORDER'],
    [{ items: [{ sku: '00931504', qty: 0 }], fulfillment: 'pickup', storeId: '13942' }, 'INVALID_ORDER'],
    [{ items: [{ sku: '__proto__', qty: 1 }], fulfillment: 'pickup', storeId: '13942' }, 'INVALID_ORDER'],
    [{ items: PREFILLED_CART, fulfillment: 'pickup', storeId: 'constructor' }, 'INVALID_ORDER'],
  ])('invalid order %# returns a handled 400 without alerting', async (body, code) => {
    const res = await request('POST', '/api/dollar-general/checkout', body);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('catalog lists products, stores and the myDG member', async () => {
    const res = await request('GET', '/api/dollar-general/catalog');
    expect(res.status).toBe(200);
    expect(res.body.products).toHaveLength(8);
    expect(res.body.stores.map((s) => s.storeNumber)).toEqual(['13942', '08715']);
    expect(res.body.member.freeDeliveriesRemaining).toBe(1);
  });

  test('placeOrder is exported for direct use', async () => {
    await expect(placeOrder({ items: PREFILLED_CART, fulfillment: 'pickup', storeId: '08715' }))
      .resolves.toMatchObject({ success: true });
  });
});
