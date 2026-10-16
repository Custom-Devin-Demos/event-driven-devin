jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { checkoutOrder, NEARBY_STORES, STORE_HOLD_DEADLINE_MS } = require('../app/services/oncall-verticals/storepickup');
const { Sentry } = require('../app/telemetry/sentry');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

jest.setTimeout(30000);

describe('store-pickup on-call checkout', () => {
  test('pickup times out while holding inventory at nearby stores', async () => {
    const started = Date.now();
    await expect(checkoutOrder({
      items: [{ sku: 'GAP-441020', qty: 1 }],
      fulfillment: 'pickup',
      storeNumber: '0412',
    })).rejects.toMatchObject({ code: 'STORE_HOLD_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
    expect(STORE_HOLD_DEADLINE_MS).toBe(8000);
    expect(NEARBY_STORES['0412']).toEqual(['0412', '0388', '0517', '0291', '0634', '0450', '0573', '0206']);
  });

  test('ship with the known promotion is fast and uses merchandise pricing only', async () => {
    const started = Date.now();
    const result = await checkoutOrder({
      items: [{ sku: 'GAP-441020', qty: 1, price: 0.01 }],
      promoCode: 'FRIENDS40',
      fulfillment: 'ship',
    });
    expect(result).toMatchObject({
      success: true,
      fulfillment: 'ship',
      store: null,
      holds: [],
      subtotal: 89.95,
      savings: 35.98,
      shipping: 0,
      tax: 4.79,
      total: 58.76,
    });
    expect(result.orderId).toMatch(/^ORD/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('ship without a promotion charges standard shipping below the free threshold', async () => {
    const result = await checkoutOrder({
      items: [{ sku: 'GAP-885210', qty: 1 }],
      fulfillment: 'ship',
    });
    expect(result).toMatchObject({
      subtotal: 34.95,
      savings: 0,
      shipping: 7,
      tax: 3.1,
      total: 45.05,
    });
  });

  test('unknown promotions are ignored', async () => {
    const result = await checkoutOrder({
      items: [{ sku: 'GAP-441020', qty: 1 }],
      promoCode: 'NOT-A-PROMO',
      fulfillment: 'ship',
    });
    expect(result).toMatchObject({ savings: 0, shipping: 0, tax: 7.98, total: 97.93 });
  });

  test('duplicate SKUs are merged and client prices are ignored', async () => {
    const result = await checkoutOrder({
      items: [
        { sku: 'GAP-885210', qty: 1, price: 0 },
        { sku: 'GAP-885210', qty: 2, price: 1000 },
      ],
    });
    expect(result.lines).toEqual([{
      sku: 'GAP-885210',
      name: '100% Cotton Authentic Shrunken T-Shirt',
      qty: 3,
      price: 34.95,
      lineTotal: 104.85,
    }]);
  });

  test.each([
    [{ items: [{ sku: 'NOPE', qty: 1 }] }],
    [{ items: [{ sku: 'GAP-441020', qty: -1 }] }],
    [{ items: [{ sku: 'GAP-441020', qty: 'oops' }] }],
    [{ items: [{ sku: 'GAP-441020', qty: 1.5 }] }],
    [{ items: [{ sku: 'GAP-441020', qty: 99 }] }],
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

  test('only pickup orders trigger the alert scenario', () => {
    expect(ALERT_SCENARIOS.storepickup.triggerWhen).toEqual({ fulfillment: 'pickup' });
    expect(ALERT_SCENARIOS.storepickup.initialClick).toBeUndefined();
  });

  test('alert scenario is latency-shaped, unlisted and free of code locations', () => {
    const scenario = ALERT_SCENARIOS.storepickup;
    expect(scenario).toMatchObject({
      vertical: 'storepickup',
      page: 'f813dd7a.html',
      apiPath: '/api/f813dd7a/checkout',
      oncallApiPath: '/api/oncall/storepickup/checkout',
      monitor: expect.stringMatching(/^p95 latency/),
      unlisted: true,
    });
    expect(JSON.stringify(scenario)).not.toMatch(/\.js\b|NEARBY_STORES|holdAtStore/);
  });

  test('service and alert scenario remain customer-neutral', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'app', 'services', 'oncall-verticals', 'storepickup.js'), 'utf8');
    expect(service).not.toMatch(/gap/i);
    expect(JSON.stringify(ALERT_SCENARIOS.storepickup)).not.toMatch(/gap/i);
  });

  test('skin uses the native page and Slack alert routing', () => {
    const skin = getOncallSkin('d36c67bf');
    expect(skin).toMatchObject({
      vertical: 'storepickup',
      alertDestination: 'slack',
      paths: ['/gap-oncall'],
      page: { file: 'f813dd7a.html' },
    });
    expect(skin.oncallOnly).toBeFalsy();
    expect(skin.devinSession).toBeUndefined();
  });

  test('native page preserves legacy checkout and exposes fulfillment options', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'f813dd7a.html'), 'utf8');
    expect(html).toContain('<title>Gap | Individual style for Women\'s, Men\'s, Baby &amp; Kids\' Clothing</title>');
    expect(html).toContain("fetch('/api/f813dd7a/checkout'");
    expect(html).toContain('name="fulfillment" value="ship" checked');
    expect(html).toContain('name="fulfillment" value="pickup"');
    expect(html).not.toContain('/api/oncall/');
  });
});
