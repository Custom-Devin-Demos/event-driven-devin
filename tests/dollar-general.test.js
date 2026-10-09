/* global describe, expect, test, jest, beforeEach, afterEach */

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
const {
  placeOrder, quoteDelivery, STORES, DELIVERY_FEE_SCHEDULES, MYDG_MEMBER,
} = require('../app/services/verticals/59c53533');
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

  test('customer config exposes only /dollar-general', () => {
    expect(dgCustomer.aliases).toEqual(['dollar-general']);
    expect(dgCustomer.triggerMode).toBe('api');
  });

  test('every Same Day Delivery store zone has a fee schedule', () => {
    expect(STORES['13942'].deliveryZone).toBe('TN-NASH-07');
    for (const store of Object.values(STORES)) {
      expect(DELIVERY_FEE_SCHEDULES[store.deliveryZone]).toBeDefined();
    }
  });

  test('TN-NASH-07 uses the same fee schedule as the other Nashville zones', () => {
    expect(DELIVERY_FEE_SCHEDULES['TN-NASH-07']).toEqual(DELIVERY_FEE_SCHEDULES['TN-NASH-01']);
    expect(DELIVERY_FEE_SCHEDULES['TN-NASH-07']).toEqual(DELIVERY_FEE_SCHEDULES['TN-NASH-03']);
  });

  test('delivery from wave 7 store 13942 places the order with the myDG free delivery', async () => {
    const res = await request('POST', '/api/dollar-general/checkout', {
      items: PREFILLED_CART,
      fulfillment: 'delivery',
      storeId: '13942',
      devinUserId: 'user-test',
      devinOrgId: 'org-test',
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      fulfillment: 'delivery',
      store: { storeNumber: '13942' },
      subtotal: 21.75,
      baseFee: 6.95,
      myDgDiscount: 6.95,
      deliveryFee: 0,
      usedFreeDelivery: true,
      tax: 2.01,
      total: 23.76,
    });
    expect(res.body.orderNumber).toMatch(/^DG\d{9}$/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reproduction requests for store 13942 delivery also succeed', async () => {
    const res = await request('POST', '/api/dollar-general/checkout', {
      items: PREFILLED_CART,
      fulfillment: 'delivery',
      storeId: '13942',
    }, { 'x-synthetic': '1' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, deliveryFee: 0 });
  });

  describe('store whose delivery zone has no fee schedule', () => {
    const TEST_STORE = '99001';

    beforeEach(() => {
      STORES[TEST_STORE] = {
        storeNumber: TEST_STORE,
        address: '1 Test Way, Knoxville, TN 37902',
        deliveryZone: 'TN-KNOX-99',
        sameDayDeliverySince: '2026-10-09',
      };
    });

    afterEach(() => {
      delete STORES[TEST_STORE];
    });

    test('delivery returns a handled 409 without Sentry or a Devin session', async () => {
      const res = await request('POST', '/api/dollar-general/checkout', {
        items: PREFILLED_CART,
        fulfillment: 'delivery',
        storeId: TEST_STORE,
      });

      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        success: false,
        errorClass: 'DeliveryUnavailableError',
        code: 'DELIVERY_UNAVAILABLE',
        error: "Same Day Delivery isn't available for this store yet",
      });
      expect(res.body.requestId).toEqual(expect.any(String));
      expect(res.body.error).not.toMatch(/TypeError|baseFee/);
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('store pickup at that store still succeeds', async () => {
      const res = await request('POST', '/api/dollar-general/checkout', {
        items: PREFILLED_CART,
        fulfillment: 'pickup',
        storeId: TEST_STORE,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, deliveryFee: 0 });
    });
  });

  test.each([undefined, null, '', 'TN-KNOX-99', '__proto__', 'constructor', 'toString'])(
    'quoteDelivery throws DeliveryUnavailableError for zone %p instead of a TypeError',
    (deliveryZone) => {
      const store = { storeNumber: '00000', deliveryZone };
      expect(() => quoteDelivery(store, MYDG_MEMBER)).toThrow(expect.objectContaining({
        name: 'DeliveryUnavailableError',
        code: 'DELIVERY_UNAVAILABLE',
        statusCode: 409,
      }));
    },
  );

  test('quoteDelivery charges the base fee when the member has no free deliveries left', () => {
    expect(quoteDelivery(STORES['13942'], { ...MYDG_MEMBER, freeDeliveriesRemaining: 0 })).toEqual({
      baseFee: 6.95,
      myDgDiscount: 0,
      deliveryFee: 6.95,
      usedFreeDelivery: false,
    });
  });

  test('a genuine checkout crash still alerts with the remediation directive', async () => {
    const schedule = DELIVERY_FEE_SCHEDULES['TN-NASH-07'];
    Object.defineProperty(DELIVERY_FEE_SCHEDULES, 'TN-NASH-07', {
      configurable: true,
      enumerable: true,
      get() { throw new TypeError('simulated pricing failure'); },
    });
    try {
      const res = await request('POST', '/api/dollar-general/checkout', {
        items: PREFILLED_CART,
        fulfillment: 'delivery',
        storeId: '13942',
        devinUserId: 'user-test',
        devinOrgId: 'org-test',
      });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'CHECKOUT_FAILED' });
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
      const alert = createSessionAndAlert.mock.calls[0][0];
      expect(alert).toMatchObject({ customer: '59c53533', devinUserId: 'user-test', devinOrgId: 'org-test' });
      expect(alert.extra).toMatchObject({ storeNumber: '13942', deliveryZone: 'TN-NASH-07', fulfillment: 'delivery' });
      expect(alert.promptAppendix).toContain('/dollar-general?repro=1');
    } finally {
      Object.defineProperty(DELIVERY_FEE_SCHEDULES, 'TN-NASH-07', {
        configurable: true, enumerable: true, writable: true, value: schedule,
      });
    }
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
