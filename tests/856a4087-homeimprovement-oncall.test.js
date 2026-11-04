jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { checkoutOrder, NEARBY_STORES, RESERVATION_DEADLINE_MS } = require('../app/services/oncall-verticals/homeimprovement');
const { Sentry } = require('../app/telemetry/sentry');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

jest.setTimeout(30000);

const CART = [
  { sku: '1001726437', qty: 1 },
  { sku: '1001562840', qty: 1 },
  { sku: '1005409281', qty: 2 },
];

describe('home-improvement on-call checkout', () => {
  test('pickup times out while reserving inventory at nearby stores', async () => {
    const started = Date.now();
    await expect(checkoutOrder({ items: CART, fulfillment: 'pickup', storeNumber: '6177' }))
      .rejects.toMatchObject({ code: 'PICKUP_RESERVATION_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
    expect(RESERVATION_DEADLINE_MS).toBe(8000);
    expect(NEARBY_STORES['6177']).toHaveLength(6);
  });

  test('delivery is fast and prices from the catalog', async () => {
    const started = Date.now();
    const result = await checkoutOrder({ items: [{ sku: '1001562840', qty: 1, price: 0.01 }], fulfillment: 'delivery' });
    expect(result).toMatchObject({
      success: true,
      fulfillment: 'delivery',
      reservations: [],
      subtotal: 99,
      delivery: 0,
      tax: 8.79,
      total: 107.79,
    });
    expect(result.orderId).toMatch(/^W\d{9}$/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('delivery below the free threshold charges a delivery fee', async () => {
    const result = await checkoutOrder({ items: [{ sku: '1005409281', qty: 1 }], fulfillment: 'delivery' });
    expect(result).toMatchObject({ subtotal: 24.98, delivery: 8.99, tax: 2.22, total: 36.19 });
  });

  test('duplicate SKUs are merged', async () => {
    const result = await checkoutOrder({ items: [{ sku: '1005409281', qty: 1 }, { sku: '1005409281', qty: 2 }] });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ sku: '1005409281', qty: 3, lineTotal: 74.94 });
  });

  test.each([
    [{ items: [{ sku: 'NOPE', qty: 1 }] }],
    [{ items: [{ sku: '1001726437', qty: -1 }] }],
    [{ items: [{ sku: '1001726437', qty: 1.5 }] }],
    [{ items: [{ sku: '1001726437', qty: 99 }] }],
    [{ items: [] }],
    [{ items: undefined }],
  ])('rejects invalid carts as INVALID_CART: %j', async (data) => {
    await expect(checkoutOrder(data)).rejects.toMatchObject({ code: 'INVALID_CART' });
  });

  test('invalid carts do not reach Sentry', async () => {
    Sentry.captureException.mockClear();
    await expect(checkoutOrder({ items: [] })).rejects.toMatchObject({ code: 'INVALID_CART' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('alert scenario is latency-shaped, pickup-triggered, unlisted and free of code locations', () => {
    const scenario = ALERT_SCENARIOS.homeimprovement;
    expect(scenario).toMatchObject({
      vertical: 'homeimprovement',
      page: '856a4087.html',
      apiPath: '/api/856a4087/checkout',
      oncallApiPath: '/api/oncall/homeimprovement/checkout',
      monitor: expect.stringMatching(/^p95 latency/),
      triggerWhen: { fulfillment: 'pickup' },
      unlisted: true,
    });
    expect(JSON.stringify(scenario)).not.toMatch(/\.js\b|NEARBY_STORES|reserveAtStore/);
  });

  test('service, scenario and alert card stay customer-neutral', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'app', 'services', 'oncall-verticals', 'homeimprovement.js'), 'utf8');
    expect(service).not.toMatch(/home ?depot/i);
    expect(JSON.stringify(ALERT_SCENARIOS.homeimprovement)).not.toMatch(/home ?depot/i);
    expect(JSON.stringify(getOncallSkin('856a4087').alertCard)).not.toMatch(/home ?depot/i);
  });

  test('skin uses the native page and Slack alert routing', () => {
    const skin = getOncallSkin('856a4087');
    expect(skin).toMatchObject({
      vertical: 'homeimprovement',
      alertDestination: 'slack',
      paths: ['/homedepot-oncall'],
      triggerWhen: { fulfillment: 'pickup' },
      page: { file: '856a4087.html', title: 'Cart - The Home Depot' },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A HOME DEPOT SITE/);
  });

  test('native page posts the legacy checkout path with the selected fulfillment', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', '856a4087.html'), 'utf8');
    expect(html).toContain('<title>Cart - The Home Depot</title>');
    expect(html).toContain("fetch('/api/856a4087/checkout'");
    expect(html).toContain('fulfillment: state.fulfillment');
    expect(html).toContain('data-fulfill="delivery"');
    expect(html).not.toContain('/api/oncall/');
  });
});
