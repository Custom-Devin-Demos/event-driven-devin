/* global afterAll, beforeAll, beforeEach, describe, expect, test */

const express = require('express');
const http = require('http');

const {
  submitSampleOrder,
  PRESCRIBERS,
  PRODUCTS,
  SAMPLE_ORDER_TEST_HOOKS,
} = require('../app/services/oncall-verticals/samples');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

jest.setTimeout(15000);

const PRESCRIBER = PRESCRIBERS[0];
const VALID_ORDER = {
  hcpNpi: PRESCRIBER.hcpNpi,
  stateLicense: PRESCRIBER.stateLicense,
  shipToAddressId: PRESCRIBER.shipToAddresses[0].addressId,
  items: [{ productId: PRODUCTS[0].productId, quantity: 1 }],
  signature: PRESCRIBER.name,
};

let server;
let baseUrl;

beforeEach(() => {
  SAMPLE_ORDER_TEST_HOOKS.licenseVerificationLatencyMs = 0;
  SAMPLE_ORDER_TEST_HOOKS.verificationCalls = 0;
});

describe('HCP sample-order submissions', () => {
  test('rejects invalid licenses, controlled products, excessive quantities and missing signatures quickly', async () => {
    const invalidOrders = [
      [
        {
          hcpNpi: PRESCRIBERS[2].hcpNpi,
          stateLicense: PRESCRIBERS[2].stateLicense,
          shipToAddressId: PRESCRIBERS[2].shipToAddresses[0].addressId,
        },
        'LICENSE_NOT_VALID',
      ],
      [
        { items: [{ productId: PRODUCTS.find((product) => product.controlled).productId, quantity: 1 }] },
        'PRODUCT_NOT_SAMPLEABLE',
      ],
      [
        { items: [{ productId: PRODUCTS[0].productId, quantity: PRODUCTS[0].maxUnitsPerRequest + 1 }] },
        'QUANTITY_LIMIT_EXCEEDED',
      ],
      [
        {
          items: [
            { productId: PRODUCTS[0].productId, quantity: 5 },
            { productId: PRODUCTS[0].productId, quantity: 4 },
          ],
        },
        'QUANTITY_LIMIT_EXCEEDED',
      ],
      [{ signature: '' }, 'SIGNATURE_REQUIRED'],
    ];

    for (const [overrides, code] of invalidOrders) {
      const started = Date.now();
      await expect(submitSampleOrder({ ...VALID_ORDER, ...overrides })).rejects.toMatchObject({ code });
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  test('returns confirmed orders and verifies once per unit allocation and line item', async () => {
    const single = await submitSampleOrder(VALID_ORDER);
    expect(single).toMatchObject({
      success: true,
      orderId: expect.stringMatching(/^SO-[0-9A-F]{8}$/),
      status: 'CONFIRMED',
      estimatedDelivery: expect.any(String),
      durationMs: expect.any(Number),
    });
    expect(single.items).toHaveLength(1);
    expect(SAMPLE_ORDER_TEST_HOOKS.verificationCalls).toBe(1);

    SAMPLE_ORDER_TEST_HOOKS.verificationCalls = 0;
    const multiLine = await submitSampleOrder({
      ...VALID_ORDER,
      items: [
        { productId: PRODUCTS[0].productId, quantity: 1 },
        { productId: PRODUCTS[1].productId, quantity: 1 },
        { productId: PRODUCTS[2].productId, quantity: 1 },
        { productId: PRODUCTS[0].productId, quantity: 1 },
      ],
    });
    expect(multiLine.items).toHaveLength(4);
    expect(SAMPLE_ORDER_TEST_HOOKS.verificationCalls).toBe(4);

    SAMPLE_ORDER_TEST_HOOKS.verificationCalls = 0;
    await submitSampleOrder({
      ...VALID_ORDER,
      items: [{ productId: PRODUCTS[0].productId, quantity: 3 }],
    });
    expect(SAMPLE_ORDER_TEST_HOOKS.verificationCalls).toBe(3);
  });

  test('one four-unit line completes in roughly 2.4 seconds at the default verification latency', async () => {
    SAMPLE_ORDER_TEST_HOOKS.licenseVerificationLatencyMs = 600;
    const result = await submitSampleOrder({
      ...VALID_ORDER,
      items: [{ productId: PRODUCTS[0].productId, quantity: 4 }],
    });

    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(2200);
    expect(result.durationMs).toBeLessThan(5000);
    expect(SAMPLE_ORDER_TEST_HOOKS.verificationCalls).toBe(4);
  });
});

describe('POST /api/oncall/lifesciences/sample-order', () => {
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(oncallVerticalRoutes);
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => stopGateway().then(() => done()));
  });

  test('uses route defaults for a successful four-line order', async () => {
    const response = await fetch(`${baseUrl}/api/oncall/lifesciences/sample-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      success: true,
      orderId: expect.stringMatching(/^SO-[0-9A-F]{8}$/),
      status: 'CONFIRMED',
      durationMs: expect.any(Number),
    });
    expect(result.items).toHaveLength(4);
    expect(SAMPLE_ORDER_TEST_HOOKS.verificationCalls).toBe(16);
  });

  test('maps invalid prescriber licenses to HTTP 422', async () => {
    const response = await fetch(`${baseUrl}/api/oncall/lifesciences/sample-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...VALID_ORDER,
        hcpNpi: PRESCRIBERS[2].hcpNpi,
        stateLicense: PRESCRIBERS[2].stateLicense,
        shipToAddressId: PRESCRIBERS[2].shipToAddresses[0].addressId,
      }),
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      success: false,
      code: 'LICENSE_NOT_VALID',
    });
  });
});
