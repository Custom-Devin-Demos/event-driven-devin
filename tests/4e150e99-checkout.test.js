jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  processCheckout,
  computeOrderTotal,
  formatReceipt,
  applyPromotions,
  getApplicableDiscount,
  CATALOG,
} = require('../app/services/verticals/4e150e99');

const DEFAULT_ORDER = {
  userId: 'test-user',
  items: [
    { sku: 'VZ-DEV-IP17P-256', qty: 1, price: 45.83 },
    { sku: 'VZ-PLN-UNL-ULT', qty: 1, price: 90.00 },
    { sku: 'VZ-ADD-VMP', qty: 1, price: 18.00 },
  ],
  subtotal: 153.83,
  state: 'NY',
};

describe('Verizon checkout', () => {
  test.each(['ZZ', 'constructor'])('processCheckout rejects invalid state %s without triggering telemetry or a Devin session', async (state) => {
    jest.clearAllMocks();

    await expect(processCheckout({ ...DEFAULT_ORDER, state }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'INVALID_STATE',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('processCheckout rejects with the planted TypeError and triggers a Devin session', async () => {
    await expect(processCheckout(DEFAULT_ORDER))
      .rejects.toThrow(/reading 'name'/);
    await expect(processCheckout(DEFAULT_ORDER))
      .rejects.toBeInstanceOf(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: '4e150e99',
        service: 'verizon-ecommerce',
      }),
    );

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
  });

  test('computeOrderTotal applies NY sales tax and the 10% bundle tier', () => {
    const result = computeOrderTotal(153.83, 'NY');

    expect(result.tax).toBe(13.65);
    expect(result.discount).toBe(16.75);
    expect(result.total).toBe(150.73);
    expect(result.currency).toBe('USD');
    expect(result.taxLabel).toBe('Sales tax');
  });

  test.each(['ZZ', 'constructor'])('computeOrderTotal rejects invalid state %s', (state) => {
    expect(() => computeOrderTotal(100, state)).toThrow(`Unknown state: ${state}`);
    try {
      computeOrderTotal(100, state);
    } catch (error) {
      expect(error.code).toBe('INVALID_STATE');
    }
  });

  test('formatReceipt returns names and terms for catalog-only items', () => {
    const receipt = formatReceipt(DEFAULT_ORDER.items);

    expect(receipt).toHaveLength(3);
    expect(receipt[0].name).toBe('iPhone 17 Pro 256 GB');
    expect(receipt[0].term).toBe('36-mo Device Payment');
    expect(receipt[1].term).toBe('myPlan · Month-to-month');
  });

  test('formatReceipt resolves the iPhone 18 Pro + Simplicity Plan storefront cart', () => {
    const receipt = formatReceipt([
      { sku: 'VZ-DEV-IP18P-256', qty: 1, price: 33.33 },
      { sku: 'VZ-PLN-SIMPLICITY', qty: 1, price: 30.00 },
      { sku: 'VZ-ADD-VMP', qty: 1, price: 18.00 },
    ]);

    expect(receipt.map((line) => line.name)).toEqual([
      'iPhone 18 Pro 256 GB',
      'Simplicity Plan',
      'Verizon Mobile Protect',
    ]);
  });

  test('formatReceipt throws once the promo item is merged in', () => {
    expect(() => formatReceipt(applyPromotions(DEFAULT_ORDER.items)))
      .toThrow(TypeError);
  });

  test('every catalog id carries the VZ- prefix', () => {
    expect(CATALOG.every((p) => p.id.startsWith('VZ-'))).toBe(true);
  });

  test('getApplicableDiscount respects the bundle thresholds', () => {
    expect(getApplicableDiscount(99.99).rate).toBe(0);
    expect(getApplicableDiscount(100).rate).toBe(0.05);
    expect(getApplicableDiscount(150).rate).toBe(0.10);
  });
});
