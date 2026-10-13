jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const {
  placeOrder,
  buildBagLines,
  buildOrderSummary,
  resolveSizeRun,
  CATALOG,
  FITS,
  SHIPPING_METHODS,
  STATE_TAX,
  MONOGRAM_FEE,
} = require('../app/services/verticals/ralphlauren');
const { createSessionAndAlert } = require('../app/services/devin-session');

const ICONIC_MESH = '401480-P';
const CLASSIC_SOFT_COTTON = '545294';
const TAILORED_PERFORMANCE = '100098525';

function summary(items, overrides = {}) {
  return buildOrderSummary({
    orderId: '0123abcd-0000-4000-8000-000000000000',
    lines: buildBagLines(items),
    shipping: SHIPPING_METHODS.standard,
    taxRule: STATE_TAX.NY,
    rlAccount: true,
    ...overrides,
  });
}

describe('Ralph Lauren bag totals', () => {
  test('applies the sale price, NY tax and complimentary RL Account shipping', () => {
    const order = summary([{ sku: ICONIC_MESH, size: 'M', qty: 1 }]);
    expect(order.subtotal).toBe(89.99);
    expect(order.savings).toBe(28.01);
    expect(order.shipping).toEqual({ method: 'Standard', fee: 0, eta: '3-5 business days', complimentary: true });
    expect(order.tax.amount).toBe(7.99);
    expect(order.total).toBe(97.98);
    expect(order.orderNumber).toBe('RL0123ABCD00');
  });

  test('charges standard shipping and the monogram fee for a guest', () => {
    const order = summary([{ sku: ICONIC_MESH, size: 'L', qty: 2, monogram: 'rl' }], { rlAccount: false });
    expect(order.lines[0].monogram).toBe('RL');
    expect(order.lines[0].lineTotal).toBe((89.99 + MONOGRAM_FEE) * 2);
    expect(order.shipping.fee).toBe(10);
    expect(order.shipping.complimentary).toBe(false);
  });

  test('express shipping is never complimentary and Oregon has no tax', () => {
    const order = summary([{ sku: CLASSIC_SOFT_COTTON, size: 'M', qty: 1 }], { shipping: SHIPPING_METHODS.express, taxRule: STATE_TAX.OR });
    expect(order.shipping.fee).toBe(20);
    expect(order.tax.amount).toBe(0);
    expect(order.total).toBe(145);
  });
});

describe('Ralph Lauren bag validation', () => {
  test('rejects unknown styles, bad quantities, colors, sizes and monograms as 400s', async () => {
    const cases = [
      [{ items: [{ sku: 'nope', size: 'M', qty: 1 }] }, 'UNKNOWN_SKU'],
      [{ items: [{ sku: ICONIC_MESH, size: 'M', qty: 0 }] }, 'INVALID_QUANTITY'],
      [{ items: [{ sku: ICONIC_MESH, size: 'M', qty: 1, color: 'Chartreuse' }] }, 'INVALID_COLOR'],
      [{ items: [{ sku: ICONIC_MESH, size: 'XXXL', qty: 1 }] }, 'INVALID_SIZE'],
      [{ items: [{ sku: ICONIC_MESH, size: 'M', qty: 1, monogram: 'R2D2' }] }, 'INVALID_MONOGRAM'],
      [{ items: [{ sku: CLASSIC_SOFT_COTTON, size: 'M', qty: 1, monogram: 'RL' }] }, 'MONOGRAM_UNAVAILABLE'],
      [{ items: [] }, 'EMPTY_BAG'],
      [{ items: [{ sku: ICONIC_MESH, size: 'M', qty: 1 }], shippingMethod: 'drone' }, 'UNKNOWN_SHIPPING_METHOD'],
      [{ items: [{ sku: ICONIC_MESH, size: 'M', qty: 1 }], state: 'ZZ' }, 'UNSUPPORTED_STATE'],
    ];
    for (const [body, code] of cases) {
      await expect(placeOrder(body)).rejects.toMatchObject({ status: 400, code });
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('every catalogue fit is a known fit', () => {
    for (const product of CATALOG) {
      expect(FITS[product.fit]).toBeDefined();
    }
  });
});

describe('Ralph Lauren Tailored Fit polos (intentional demo defect)', () => {
  test('Tailored Fit has no size run in FIT_SIZE_RUNS', () => {
    const tailored = CATALOG.find((product) => product.sku === TAILORED_PERFORMANCE);
    expect(tailored.fit).toBe('tailored');
    expect(resolveSizeRun(tailored)).toBeUndefined();
  });

  test('checking out a Tailored Fit polo throws a TypeError and alerts Devin', async () => {
    createSessionAndAlert.mockClear();
    await expect(placeOrder({
      items: [{ sku: ICONIC_MESH, size: 'M', qty: 1 }, { sku: TAILORED_PERFORMANCE, size: 'M', qty: 1 }],
      rlAccount: true,
    })).rejects.toBeInstanceOf(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: 'ralphlauren',
      service: 'customer-ralphlauren-checkout',
      errorType: 'TypeError',
    });
    expect(createSessionAndAlert.mock.calls[0][0].extra.fits).toEqual(['classic', 'tailored']);
  });
});
