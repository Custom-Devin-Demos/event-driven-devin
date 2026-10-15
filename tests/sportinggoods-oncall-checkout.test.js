jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { checkoutOrder } = require('../app/services/oncall-verticals/sportinggoods');
const { ALERT_SCENARIOS } = require('../app/services/oncall');

jest.setTimeout(30000);

const cart = [{ sku: '24NIKMPGSS41RDXXXRNN', qty: 1 }, { sku: '20SPAUTF1000LGCYBSKB', qty: 1 }];

describe('sporting goods on-call checkout', () => {
  test('store-pickup checkout times out holding inventory', async () => {
    const started = Date.now();
    await expect(checkoutOrder({ items: cart, memberId: 'SC-8841207733', fulfillment: 'pickup', storeNumber: '0212' }))
      .rejects.toMatchObject({ code: 'STORE_HOLD_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
  });

  test('ship-to-home checkout is fast and never hits the reward bug', async () => {
    const started = Date.now();
    const result = await checkoutOrder({ items: cart, memberId: 'SC-8841207733', fulfillment: 'ship', zipCode: '15205' });
    expect(result.success).toBe(true);
    expect(result.holds).toEqual([]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('rejects an unknown SKU without holding inventory', async () => {
    await expect(checkoutOrder({ items: [{ sku: 'NOPE', qty: 1 }], fulfillment: 'pickup' }))
      .rejects.toMatchObject({ code: 'INVALID_CART' });
  });

  test.each([
    [[{ sku: '24NIKMPGSS41RDXXXRNN', qty: -1 }]],
    [[{ sku: '24NIKMPGSS41RDXXXRNN', qty: 'oops' }]],
    [[{ sku: '24NIKMPGSS41RDXXXRNN', qty: 99 }]],
    [[]],
  ])('rejects an invalid cart %j as INVALID_CART', async (items) => {
    await expect(checkoutOrder({ items, fulfillment: 'ship' })).rejects.toMatchObject({ code: 'INVALID_CART' });
  });

  test('only store-pickup checkouts page on-call', () => {
    expect(ALERT_SCENARIOS.sportinggoods.triggerWhen).toEqual({ fulfillment: 'pickup' });
    expect(ALERT_SCENARIOS.sportinggoods.initialClick).toBe('.opt[data-f="pickup"]');
  });

  test('alert scenario is latency-shaped, unlisted and free of code locations', () => {
    const s = ALERT_SCENARIOS.sportinggoods;
    expect(s.apiPath).toBe('/api/1b17e823/checkout');
    expect(s.oncallApiPath).toBe('/api/oncall/sportinggoods/checkout');
    expect(s.monitor).toMatch(/^p95 latency/);
    expect(s.unlisted).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/\.js|1b17e823\.js|FLX/);
  });
});
