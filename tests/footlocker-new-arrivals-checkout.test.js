jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const {
  placeOrder,
  buildBagLines,
  buildOrderSummary,
  resolveSizeScale,
  CATALOG,
  GROUPS,
  SIZE_SCALES,
  SHIPPING_METHODS,
  STATE_TAX,
  FLX_POINTS_PER_DOLLAR,
} = require('../app/services/verticals/footlocker');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const JORDAN_5_OG_MENS = 'HQ797800';
const JORDAN_5_GRADE_SCHOOL = 'HQ627980';
const JORDAN_5_TODDLER = 'HQ618100';
const KNICKS_CAP = '61046984';

function summary(items, overrides = {}) {
  return buildOrderSummary({
    orderId: '0123abcd-0000-4000-8000-000000000000',
    lines: buildBagLines(items),
    shipping: SHIPPING_METHODS.standard,
    taxRule: STATE_TAX.NY,
    flxMember: true,
    ...overrides,
  });
}

describe('Foot Locker bag totals', () => {
  test('applies NY tax, free FLX standard shipping and FLX points', () => {
    const order = summary([{ sku: JORDAN_5_OG_MENS, size: '10', qty: 1 }]);
    expect(order.subtotal).toBe(215);
    expect(order.shipping).toEqual({ method: 'Standard', fee: 0, eta: '3-6 business days', complimentary: true });
    expect(order.tax.amount).toBe(19.08);
    expect(order.total).toBe(234.08);
    expect(order.flxPoints).toBe(215 * FLX_POINTS_PER_DOLLAR);
    expect(order.orderNumber).toBe('FL0123ABCD00');
  });

  test('charges standard shipping and earns no points for a guest', () => {
    const order = summary([{ sku: JORDAN_5_GRADE_SCHOOL, size: '5.5', qty: 2, color: '62798010' }], { flxMember: false });
    expect(order.lines[0]).toMatchObject({ size: '5.5', color: 'White/Silver/Black', lineTotal: 310 });
    expect(order.shipping.fee).toBe(7.99);
    expect(order.shipping.complimentary).toBe(false);
    expect(order.flxPoints).toBe(0);
  });

  test('express shipping is never free and Oregon has no tax', () => {
    const order = summary([{ sku: KNICKS_CAP, size: 'OSFA', qty: 1 }], { shipping: SHIPPING_METHODS.express, taxRule: STATE_TAX.OR });
    expect(order.shipping.fee).toBe(14.99);
    expect(order.tax.amount).toBe(0);
    expect(order.total).toBe(60.99);
  });
});

describe('Foot Locker bag validation', () => {
  test('rejects unknown styles, bad quantities, colors and sizes as 400s', async () => {
    const cases = [
      [{ items: [{ sku: 'nope', size: '10', qty: 1 }] }, 'UNKNOWN_SKU'],
      [{ items: [{ sku: JORDAN_5_OG_MENS, size: '10', qty: 0 }] }, 'INVALID_QUANTITY'],
      [{ items: [{ sku: JORDAN_5_OG_MENS, size: '10', qty: 1, color: 'Chartreuse' }] }, 'INVALID_COLOR'],
      [{ items: [{ sku: JORDAN_5_OG_MENS, size: '4', qty: 1 }] }, 'INVALID_SIZE'],
      [{ items: [] }, 'EMPTY_BAG'],
      [{ items: [{ sku: JORDAN_5_OG_MENS, size: '10', qty: 1 }], shippingMethod: 'drone' }, 'UNKNOWN_SHIPPING_METHOD'],
      [{ items: [{ sku: JORDAN_5_OG_MENS, size: '10', qty: 1 }], state: 'ZZ' }, 'UNSUPPORTED_STATE'],
      [{ items: Array.from({ length: 16 }, () => ({ sku: JORDAN_5_OG_MENS, size: '10', qty: 1 })) }, 'BAG_TOO_LARGE'],
    ];
    for (const [body, code] of cases) {
      await expect(placeOrder(body)).rejects.toMatchObject({ status: 400, code });
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('store pickup confirms with no shipping fee', async () => {
    const order = await placeOrder({ items: [{ sku: JORDAN_5_OG_MENS, size: '10.5', qty: 1 }], shippingMethod: 'pickup', state: 'WI' });
    expect(order.shipping).toMatchObject({ method: 'Store Pickup', fee: 0, complimentary: false });
  });

  test('every catalogue product belongs to a known group and lists feed sizes', () => {
    for (const product of CATALOG) {
      expect(GROUPS[product.scale]).toBeDefined();
      expect(product.sizes.length).toBeGreaterThan(0);
      expect(product.image).toMatch(/^https:\/\/images\.footlocker\.com\/is\/image\/EBFL2\//);
    }
  });
});

describe('Foot Locker Infant & Toddler styles (intentional demo defect)', () => {
  test('Toddler has no size scale in SIZE_SCALES', () => {
    const toddler = CATALOG.find((product) => product.sku === JORDAN_5_TODDLER);
    expect(toddler.scale).toBe('toddler');
    expect(SIZE_SCALES.toddler).toBeUndefined();
    expect(resolveSizeScale(toddler)).toBeUndefined();
  });

  test('checking out a Toddler style throws a TypeError and alerts Devin', async () => {
    createSessionAndAlert.mockClear();
    await expect(placeOrder({
      items: [{ sku: JORDAN_5_OG_MENS, size: '10', qty: 1 }, { sku: JORDAN_5_TODDLER, size: '5', qty: 1 }],
      flxMember: true,
    })).rejects.toBeInstanceOf(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: 'footlocker',
      service: 'customer-footlocker-checkout',
      errorType: 'TypeError',
    });
    expect(createSessionAndAlert.mock.calls[0][0].extra.groups).toEqual(['mens', 'toddler']);
  });

  test('the Sentry webhook treats the checkout failure as already alerted (no duplicate session)', () => {
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'validateSize', tags: [['alert_path', 'instant']] })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'app/services/verticals/footlocker.js in validateSize', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ issueTitle: 'TypeError', culprit: 'POST /api/footlocker/checkout', tags: [] })).toBe(true);
  });
});
