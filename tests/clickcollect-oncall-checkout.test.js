jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { checkoutOrder } = require('../app/services/oncall-verticals/clickcollect');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

jest.setTimeout(30000);

const cart = [{ sku: 'TEL-SAMS-A54', qty: 1 }];

describe('Coppel click & collect on-call checkout', () => {
  test('Recoger en tienda times out holding inventory', async () => {
    const started = Date.now();
    await expect(checkoutOrder({ items: cart, delivery: 'tienda', storeNumber: '0071' }))
      .rejects.toMatchObject({ code: 'STORE_HOLD_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(7900);
  });

  test('Recibir a domicilio is fast and holds nothing', async () => {
    const started = Date.now();
    const result = await checkoutOrder({ items: cart, delivery: 'domicilio' });
    expect(result).toMatchObject({ success: true, delivery: 'domicilio', holds: [], currency: 'MXN' });
    expect(result.total).toBe(6499);
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('accepts any quantity the cart page can build', async () => {
    const result = await checkoutOrder({ items: [{ sku: 'TEL-SAMS-A54', qty: 11 }], delivery: 'domicilio' });
    expect(result.total).toBe(6499 * 11);
  });

  test.each([
    [[{ sku: 'NOPE', qty: 1 }]],
    [[{ sku: 'TEL-SAMS-A54', qty: 0 }]],
    [[{ sku: 'TEL-SAMS-A54', qty: 'oops' }]],
    [[{ sku: 'TEL-SAMS-A54', qty: 1.5 }]],
    [[]],
  ])('rejects an invalid cart %j as INVALID_CART', async (items) => {
    await expect(checkoutOrder({ items, delivery: 'tienda' })).rejects.toMatchObject({ code: 'INVALID_CART' });
  });

  test('only Recoger en tienda pages on-call and the page preselects it', () => {
    expect(ALERT_SCENARIOS.clickcollect.triggerWhen).toEqual({ delivery: 'tienda' });
    expect(ALERT_SCENARIOS.clickcollect.initialClick).toBe('.delivery-opt[data-delivery="tienda"]');
  });

  test('alert scenario is latency-shaped, unlisted and free of code locations', () => {
    const s = ALERT_SCENARIOS.clickcollect;
    expect(s.apiPath).toBe('/api/coppel/checkout');
    expect(s.oncallApiPath).toBe('/api/oncall/clickcollect/checkout');
    expect(s.monitor).toMatch(/^p95 latency/);
    expect(s.unlisted).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/\.js\b|NEARBY_STORES|holdAtStore/);
  });

  test('Coppel skin pages the presenter, in Spanish, on the native cart page', () => {
    const skin = getOncallSkin('04eac4a1');
    expect(skin).toMatchObject({
      vertical: 'clickcollect',
      locale: 'es',
      alertDestination: 'slack',
      devinSession: { auto: true, onCallIsTriggerer: true },
      page: { file: 'coppel.html', title: 'Mi carrito | Coppel' },
    });
    // oncallOnly would hijack /coppel, the legacy automated-alert demo.
    expect(skin.oncallOnly).toBeFalsy();
  });
});
