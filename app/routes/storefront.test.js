/**
 * Regression tests for storefront checkout — formatReceipt bug fix.
 *
 * Covers NODE-EXPRESS-K: TypeError when formatReceipt encounters items
 * whose SKU is not present in the PRODUCTS catalog (e.g. promotional items).
 */

const PRODUCTS = [
  { id: 'WIDGET-001', name: 'Premium Widget', price: 29.99, category: 'widgets' },
  { id: 'WIDGET-002', name: 'Standard Widget', price: 19.99, category: 'widgets' },
  { id: 'GADGET-001', name: 'Super Gadget', price: 49.99, category: 'gadgets' },
  { id: 'GADGET-002', name: 'Mini Gadget', price: 14.99, category: 'gadgets' },
  { id: 'TOOL-001', name: 'Power Tool Pro', price: 89.99, category: 'tools' },
  { id: 'TOOL-002', name: 'Precision Tool', price: 59.99, category: 'tools' },
  { id: 'ACC-001', name: 'Widget Accessory Kit', price: 9.99, category: 'accessories' },
  { id: 'ACC-002', name: 'Gadget Carrying Case', price: 24.99, category: 'accessories' },
];

const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-GIFT-2026', name: 'Free Spring Gift', price: 0, qty: 1 },
];

function applyPromotions(items) {
  return [...items, ...ACTIVE_PROMOTIONS];
}

function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = PRODUCTS.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product ? product.name : item.name || 'Unknown Product',
      category: product ? product.category : item.category || 'promo',
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

describe('formatReceipt', () => {
  test('returns correct receipt for catalog products', () => {
    const items = [{ sku: 'WIDGET-001', qty: 2, price: 29.99 }];
    const receipt = formatReceipt(items);

    expect(receipt).toHaveLength(1);
    expect(receipt[0]).toEqual({
      sku: 'WIDGET-001',
      name: 'Premium Widget',
      category: 'widgets',
      qty: 2,
      lineTotal: 59.98,
    });
  });

  test('does not crash on promotional items not in PRODUCTS catalog (NODE-EXPRESS-K regression)', () => {
    const customerItems = [{ sku: 'WIDGET-001', qty: 1, price: 29.99 }];
    const allItems = applyPromotions(customerItems);

    expect(() => formatReceipt(allItems)).not.toThrow();

    const receipt = formatReceipt(allItems);
    expect(receipt).toHaveLength(2);

    // Promo item should use its own name/category instead of crashing
    const promoLine = receipt.find((r) => r.sku === 'PROMO-GIFT-2026');
    expect(promoLine).toBeDefined();
    expect(promoLine.name).toBe('Free Spring Gift');
    expect(promoLine.category).toBe('promo');
    expect(promoLine.lineTotal).toBe(0);
  });

  test('handles item with unknown SKU and no name property', () => {
    const items = [{ sku: 'NONEXISTENT-999', qty: 1, price: 5.00 }];

    expect(() => formatReceipt(items)).not.toThrow();

    const receipt = formatReceipt(items);
    expect(receipt[0].name).toBe('Unknown Product');
    expect(receipt[0].category).toBe('promo');
    expect(receipt[0].lineTotal).toBe(5.00);
  });

  test('handles item with unknown SKU but with name and category properties', () => {
    const items = [{ sku: 'CUSTOM-001', name: 'Custom Item', category: 'special', qty: 3, price: 10.00 }];

    const receipt = formatReceipt(items);
    expect(receipt[0].name).toBe('Custom Item');
    expect(receipt[0].category).toBe('special');
    expect(receipt[0].lineTotal).toBe(30.00);
  });

  test('handles mixed catalog and non-catalog items', () => {
    const items = [
      { sku: 'GADGET-001', qty: 1, price: 49.99 },
      { sku: 'PROMO-GIFT-2026', name: 'Free Spring Gift', price: 0, qty: 1 },
      { sku: 'UNKNOWN-SKU', qty: 2, price: 15.00 },
    ];

    expect(() => formatReceipt(items)).not.toThrow();

    const receipt = formatReceipt(items);
    expect(receipt).toHaveLength(3);
    expect(receipt[0].name).toBe('Super Gadget');
    expect(receipt[1].name).toBe('Free Spring Gift');
    expect(receipt[2].name).toBe('Unknown Product');
  });

  test('handles empty items array', () => {
    const receipt = formatReceipt([]);
    expect(receipt).toEqual([]);
  });
});

describe('applyPromotions', () => {
  test('appends promotional items to customer items', () => {
    const items = [{ sku: 'WIDGET-001', qty: 1, price: 29.99 }];
    const result = applyPromotions(items);

    expect(result).toHaveLength(2);
    expect(result[1].sku).toBe('PROMO-GIFT-2026');
  });

  test('does not mutate the original items array', () => {
    const items = [{ sku: 'WIDGET-001', qty: 1, price: 29.99 }];
    const original = [...items];
    applyPromotions(items);

    expect(items).toEqual(original);
  });
});
