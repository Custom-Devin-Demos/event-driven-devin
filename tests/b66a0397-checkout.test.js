/* global describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { processCheckout } = require('../app/services/verticals/b66a0397');

const FULL_CART = [
  { sku: 'DSG-NK-PEG41', qty: 1, price: 140.00 },
  { sku: 'DSG-SPL-TF1K', qty: 1, price: 64.99 },
  { sku: 'DSG-CAL-NRG78', qty: 1, price: 59.99 },
  { sku: 'DSG-HF-32WM', qty: 1, price: 44.95 },
];

function order(overrides) {
  return {
    userId: 'usr_test', items: FULL_CART, state: 'PA', shippingMethod: 'standard', scorecardTier: 'gold', ...overrides,
  };
}

describe("DICK'S checkout (b66a0397)", () => {
  test('ScoreCard Gold cart over the gift threshold crashes the receipt and alerts', async () => {
    await expect(processCheckout(order())).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ customer: 'b66a0397' }));
  });

  test('cart under the gift threshold is confirmed', async () => {
    const result = await processCheckout(order({ items: FULL_CART.slice(1) }));
    expect(result).toMatchObject({ success: true, subtotal: 169.93, tax: 10.2, shipping: 0, total: 180.13 });
    expect(result.scorecard.pointsEarned).toBe(254);
  });

  test('standard ScoreCard members never receive the gift', async () => {
    const result = await processCheckout(order({ scorecardTier: 'member' }));
    expect(result.success).toBe(true);
    expect(result.receipt).toHaveLength(4);
  });
});
