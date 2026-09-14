jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const {
  placeOrder,
  buildCartLines,
  buildOrderSummary,
  computeCtMoney,
  resolveBonusEvent,
  TENDERS,
  FULFILMENT_METHODS,
  STORES,
  BONUS_EVENTS,
} = require('../app/services/verticals/10397dc6');
const { createSessionAndAlert } = require('../app/services/devin-session');

const mastercard = TENDERS['triangle-mastercard'];
const rewardsCard = TENDERS['triangle-rewards'];

function summary(items, overrides = {}) {
  return buildOrderSummary({
    orderId: '0123abcd-0000-4000-8000-000000000000',
    lines: buildCartLines(items),
    tender: mastercard,
    fulfilment: FULFILMENT_METHODS['ship-to-home'],
    store: STORES['ON-0128'],
    promoCode: null,
    ...overrides,
  });
}

describe('Canadian Tire order totals', () => {
  test('applies HST, free ship-to-home over $99 and the sale savings', () => {
    const order = summary([{ sku: '1427071', qty: 1 }]);
    expect(order.subtotal).toBe(199.99);
    expect(order.savings).toBe(250);
    expect(order.fulfilment.fee).toBe(0);
    expect(order.tax.amount).toBe(26);
    expect(order.total).toBe(225.99);
    expect(order.orderNumber).toBe('CT-0123ABCD');
  });

  test('BC pickup uses GST + PST instead of Ontario HST', () => {
    const bc = summary([{ sku: '0396176', qty: 1 }], { fulfilment: FULFILMENT_METHODS['pickup-in-store'], store: STORES['BC-0311'] });
    expect(bc.tax).toEqual({ label: 'GST (5%) + PST (7%)', province: 'BC', amount: 1.2 });
    expect(bc.total).toBe(11.19);
  });

  test('rejects unknown SKUs and non-integer or out-of-range quantities', () => {
    expect(() => buildCartLines([{ sku: 'nope', qty: 1 }])).toThrow(expect.objectContaining({ code: 'UNKNOWN_SKU', status: 400 }));
    expect(() => buildCartLines([{ sku: '0072021', qty: 1.5 }])).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
    expect(() => buildCartLines([{ sku: '0072021', qty: 0 }])).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
    expect(() => buildCartLines([{ sku: '0072021', qty: 100 }])).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
    expect(() => buildCartLines([{ sku: '0072021', qty: 1, price: 0.01 }])).not.toThrow();
    expect(buildCartLines([{ sku: '0072021', qty: 1, price: 0.01 }])[0].price).toBe(164.99);
  });

  test('charges the ship-to-home fee under the free threshold and never for pickup', () => {
    expect(summary([{ sku: '0396176', qty: 2 }]).fulfilment.fee).toBe(9.99);
    const pickup = summary([{ sku: '0396176', qty: 2 }], { fulfilment: FULFILMENT_METHODS['pickup-in-store'] });
    expect(pickup.fulfilment.fee).toBe(0);
    expect(pickup.fulfilment.store).toBe('Toronto (Leslie & Lakeshore), ON');
  });
});

describe('CT Money earn', () => {
  test('base earn follows the tender rate', () => {
    const [line] = buildCartLines([{ sku: '1427071', qty: 1 }]);
    expect(computeCtMoney(line, mastercard, null)).toBe(8);
    expect(computeCtMoney(line, rewardsCard, null)).toBe(0.8);
  });

  test('kitchen bonus multiplies eligible lines only', () => {
    const [cookware, carWash] = buildCartLines([{ sku: '1427071', qty: 1 }, { sku: '0396176', qty: 1 }]);
    expect(computeCtMoney(cookware, mastercard, 'KITCHEN10X')).toBe(80);
    expect(computeCtMoney(carWash, mastercard, 'KITCHEN10X')).toBe(0.4);
  });

  test('tire bonus applies 30x to all-season tires on a Triangle credit card', () => {
    const [tire] = buildCartLines([{ sku: '0072021', qty: 4 }]);
    expect(resolveBonusEvent('BTTS30X', tire, mastercard)).toBe(BONUS_EVENTS.BTTS30X);
    expect(computeCtMoney(tire, mastercard, 'BTTS30X')).toBe(791.95);
  });

  test('tire bonus is a credit-card exclusive: Rewards card earns base only', () => {
    const [tire] = buildCartLines([{ sku: '0072021', qty: 4 }]);
    expect(computeCtMoney(tire, rewardsCard, 'BTTS30X')).toBe(2.64);
  });

  test('the tire event has no entry for winter tires', () => {
    const [tire] = buildCartLines([{ sku: '0078551', qty: 4 }]);
    expect(resolveBonusEvent('BTTS30X', tire, mastercard)).toBeUndefined();
  });
});

describe('placeOrder', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('confirms an all-season tire order', async () => {
    const order = await placeOrder({ items: [{ sku: '0072021', qty: 4 }], promoCode: 'BTTS30X', tender: 'triangle-mastercard' });
    expect(order.status).toBe('confirmed');
    expect(order.rewards.ctMoneyEarned).toBe(791.95);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a winter-tire order with the tire event surfaces a TypeError and alerts Devin', async () => {
    await expect(placeOrder({
      items: [{ sku: '0078551', qty: 4 }],
      promoCode: 'BTTS30X',
      tender: 'triangle-mastercard',
      devinUserId: 'user-1',
    })).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: '10397dc6',
      service: 'customer-10397dc6-checkout',
      errorType: 'TypeError',
      devinUserId: 'user-1',
    });
  });

  test('rejects an empty cart with a coded error and does not alert', async () => {
    await expect(placeOrder({ items: [] })).rejects.toMatchObject({ code: 'EMPTY_CART', status: 400 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
