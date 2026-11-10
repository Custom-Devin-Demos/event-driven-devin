jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const { checkoutBasket, MEMBERS, REDEMPTION_DEADLINE_MS } = require('../app/services/oncall-verticals/brandstore');
const { Sentry } = require('../app/telemetry/sentry');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

jest.setTimeout(30000);

const BASKET = [
  { sku: '13921461', qty: 1 },
  { sku: '14532880', qty: 1 },
  { sku: '14118237', qty: 2 },
];

describe('brand-store on-call basket checkout', () => {
  test('points redemption times out while re-reading the loyalty ledger', async () => {
    const started = Date.now();
    await expect(checkoutBasket({ items: BASKET, redeemPointz: true, memberId: 'PZ-5710442' }))
      .rejects.toMatchObject({ code: 'POINTZ_REDEMPTION_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
    expect(REDEMPTION_DEADLINE_MS).toBe(8000);
    expect(MEMBERS['PZ-5710442'].orderIds).toHaveLength(14);
  });

  test('checkout without redemption is fast and prices from the catalog', async () => {
    const started = Date.now();
    const result = await checkoutBasket({ items: [...BASKET.slice(0, 2), { sku: '14118237', qty: 2, price: 0.01 }] });
    expect(result).toMatchObject({
      success: true,
      redeemPointz: false,
      subtotal: 46.98,
      pointzDiscount: 0,
      delivery: 0,
      total: 46.98,
      pointzEarned: 400,
    });
    expect(result.orderId).toMatch(/^HTH\d{8}$/);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('baskets under £25 pay delivery', async () => {
    const result = await checkoutBasket({ items: [{ sku: '14118237', qty: 1 }] });
    expect(result).toMatchObject({ subtotal: 9.99, delivery: 3.5, total: 13.49 });
  });

  test('duplicate SKUs are merged', async () => {
    const result = await checkoutBasket({ items: [{ sku: '14118237', qty: 1 }, { sku: '14118237', qty: 2 }] });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({ sku: '14118237', qty: 3, lineTotal: 29.97 });
  });

  test.each([
    [{ items: [{ sku: 'NOPE', qty: 1 }] }],
    [{ items: [{ sku: '13921461', qty: -1 }] }],
    [{ items: [{ sku: '13921461', qty: 1.5 }] }],
    [{ items: [{ sku: '13921461', qty: 99 }] }],
    [{ items: [] }],
    [{ items: undefined }],
  ])('rejects invalid baskets as INVALID_BASKET: %j', async (data) => {
    await expect(checkoutBasket(data)).rejects.toMatchObject({ code: 'INVALID_BASKET' });
  });

  test('invalid baskets do not reach Sentry', async () => {
    Sentry.captureException.mockClear();
    await expect(checkoutBasket({ items: [], redeemPointz: true })).rejects.toMatchObject({ code: 'INVALID_BASKET' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('alert scenario is latency-shaped, redemption-triggered, unlisted and free of code locations', () => {
    const scenario = ALERT_SCENARIOS.brandstore;
    expect(scenario).toMatchObject({
      vertical: 'brandstore',
      page: '2a7359ff.html',
      apiPath: '/api/2a7359ff/checkout',
      oncallApiPath: '/api/oncall/brandstore/checkout',
      monitor: expect.stringMatching(/^p95 latency/),
      triggerWhen: { redeemPointz: true },
      unlisted: true,
    });
    expect(JSON.stringify(scenario)).not.toMatch(/\.js\b|MEMBERS|resolveRedeemableBalance|fetchOrderEarnings/);
  });

  test('service, scenario and alert card stay customer-neutral', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'app', 'services', 'oncall-verticals', 'brandstore.js'), 'utf8');
    expect(service).not.toMatch(/heinz|kraft/i);
    expect(JSON.stringify(ALERT_SCENARIOS.brandstore)).not.toMatch(/heinz|kraft/i);
    expect(JSON.stringify(getOncallSkin('2a7359ff').alertCard)).not.toMatch(/heinz|kraft/i);
  });

  test('skin uses the native page and Slack alert routing', () => {
    const skin = getOncallSkin('2a7359ff');
    expect(skin).toMatchObject({
      vertical: 'brandstore',
      alertDestination: 'slack',
      paths: ['/kraftheinz-oncall', '/heinz-oncall'],
      triggerWhen: { redeemPointz: true },
      page: { file: '2a7359ff.html', title: 'Your Shopping Basket | Heinz To Home' },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A KRAFT HEINZ SITE/);
  });

  test('native page posts the legacy checkout path with the redemption choice', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', '2a7359ff.html'), 'utf8');
    expect(html).toContain('<title>Your Shopping Basket | Heinz To Home</title>');
    expect(html).toContain("fetch('/api/2a7359ff/checkout'");
    expect(html).toContain('redeemPointz: state.redeem');
    expect(html).toContain('id="redeem-pointz" checked');
    expect(html).not.toContain('/api/oncall/');
  });
});
