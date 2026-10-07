const express = require('express');
const http = require('http');

const { submitOrder, DISTRIBUTION_CENTERS } = require('../app/services/oncall-verticals/vaccines');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');

jest.setTimeout(30000);

describe('vaccine order submission', () => {
  test('times out before reaching the center that holds the allocation', async () => {
    await expect(submitOrder({ ndc: '5816084952', quantity: 2 }))
      .rejects.toMatchObject({ code: 'ALLOCATION_TIMEOUT' });
  });

  test('rejects an unknown NDC without probing any center', async () => {
    const started = Date.now();
    await expect(submitOrder({ ndc: '0000000000', quantity: 1 }))
      .rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('places the order once the center walk is short enough, priced like the page', async () => {
    const trimmed = DISTRIBUTION_CENTERS.splice(0, DISTRIBUTION_CENTERS.length - 2);
    try {
      const result = await submitOrder({ ndc: '58160-849-52', quantity: 2, delivery: 'nextday' });
      expect(result.success).toBe(true);
      expect(result.orderId).toMatch(/^ORD-[0-9A-F]{8}$/);
      expect(result.doses).toBe(20);
      expect(result.total).toBe(4095);

      const premium = await submitOrder({ ndc: '5816084952', quantity: 2, accountTier: 'premium' });
      expect(premium.unitPrice).toBe(1908.2);
      expect(premium.total).toBe(3816.4);

      const basic = await submitOrder({ ndc: '5816082111', quantity: 3, accountTier: 'basic', delivery: 'nextday' });
      expect(basic.unitPrice).toBe(664.2);
      expect(basic.total).toBe(2027.6);
    } finally {
      DISTRIBUTION_CENTERS.unshift(...trimmed);
    }
  });
});

describe('POST /api/oncall/vaccines/order', () => {
  let server;
  let baseUrl;

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
    server.close(done);
  });

  test('answers 504 with the allocation timeout after ~8s', async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/oncall/vaccines/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ndc: '5816084952', quantity: 2, shipTo: 'ACCT-2101' }),
    });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({
      success: false,
      code: 'ALLOCATION_TIMEOUT',
      error: expect.stringMatching(/timed out while confirming vaccine allocation/),
    });
    expect(elapsed).toBeGreaterThanOrEqual(7900);
  });
});
