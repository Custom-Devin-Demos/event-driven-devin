jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const {
  processCheckout,
  computeOrderTotal,
  formatReceipt,
  applyPromotions,
  getApplicableDiscount,
  CATALOG,
} = require('../app/services/verticals/adbe35bc');

const DEFAULT_ORDER = {
  userId: 'test-user',
  items: [
    { sku: 'RGR-DEV-IP17P-256', qty: 1, price: 56.25 },
    { sku: 'RGR-PLN-5GP-100', qty: 1, price: 95.00 },
    { sku: 'RGR-ADD-APPLECARE', qty: 1, price: 13.99 },
  ],
  subtotal: 165.24,
  province: 'ON',
};

describe('rogers checkout', () => {
  test('processCheckout rejects with the planted TypeError and triggers a Devin session', async () => {
    await expect(processCheckout(DEFAULT_ORDER))
      .rejects.toThrow(/reading 'name'/);
    await expect(processCheckout(DEFAULT_ORDER))
      .rejects.toBeInstanceOf(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'adbe35bc',
        service: 'rogers-ecommerce',
      }),
    );
  });

  test('computeOrderTotal applies ON HST and the 10% bundle tier', () => {
    const result = computeOrderTotal(165.24, 'ON');

    expect(result.tax).toBe(21.48);
    expect(result.discount).toBe(18.67);
    expect(result.total).toBe(168.05);
    expect(result.currency).toBe('CAD');
    expect(result.taxLabel).toBe('HST');
  });

  test('computeOrderTotal rejects an unknown province', () => {
    expect(() => computeOrderTotal(100, 'ZZ')).toThrow('Unknown province: ZZ');
    try {
      computeOrderTotal(100, 'ZZ');
    } catch (error) {
      expect(error.code).toBe('INVALID_PROVINCE');
    }
  });

  test('formatReceipt returns names and terms for catalog-only items', () => {
    const receipt = formatReceipt(DEFAULT_ORDER.items);

    expect(receipt).toHaveLength(3);
    expect(receipt[0].name).toBe('iPhone 17 Pro 256 GB');
    expect(receipt[0].term).toBe('24-mo Rogers Financing');
    expect(receipt[1].term).toBe('Month-to-month');
  });

  test('formatReceipt throws once the promo item is merged in', () => {
    expect(() => formatReceipt(applyPromotions(DEFAULT_ORDER.items)))
      .toThrow(TypeError);
  });

  test('every catalog id carries the RGR- prefix', () => {
    expect(CATALOG.every((p) => p.id.startsWith('RGR-'))).toBe(true);
  });

  test('getApplicableDiscount respects the bundle thresholds', () => {
    expect(getApplicableDiscount(99.99).rate).toBe(0);
    expect(getApplicableDiscount(100).rate).toBe(0.05);
    expect(getApplicableDiscount(150).rate).toBe(0.10);
  });
});
