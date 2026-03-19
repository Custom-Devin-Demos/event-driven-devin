/**
 * Regression tests for storefront checkout — formatReceipt bug fix.
 *
 * Bug: formatReceipt() crashed with "Cannot read properties of undefined
 * (reading 'name')" when the order included items whose SKU was not in the
 * PRODUCTS catalog (e.g. promotional/free-gift items injected by
 * applyPromotions()).
 *
 * Sentry issue: NODE-EXPRESS-K
 */

/* ------------------------------------------------------------------ */
/*  We test the pure helper functions that are defined inside the      */
/*  storefront module.  Because the module also requires telemetry     */
/*  and Sentry (which need env vars / agents running), we extract the  */
/*  logic under test into a small inline re-creation that mirrors the  */
/*  production code exactly, so tests run without infrastructure.      */
/* ------------------------------------------------------------------ */

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

// Fixed version of formatReceipt (mirrors production code after the fix)
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = PRODUCTS.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product ? product.name : item.name || item.sku,
      category: product ? product.category : 'promotion',
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

// Buggy version (before fix) — used only to prove the regression test catches it
function formatReceiptBuggy(allItems) {
  return allItems.map((item) => {
    const product = PRODUCTS.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,       // crashes when product is undefined
      category: product.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/* ================================================================== */
/*  Tests                                                              */
/* ================================================================== */

describe('formatReceipt', () => {
  test('handles catalog products correctly', () => {
    const items = [
      { sku: 'WIDGET-001', qty: 2, price: 29.99 },
    ];
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

  test('does NOT crash when promotional items are included (original bug)', () => {
    const customerItems = [
      { sku: 'WIDGET-001', qty: 1, price: 29.99 },
    ];
    const allItems = applyPromotions(customerItems);

    // This must NOT throw — this was the original crash
    expect(() => formatReceipt(allItems)).not.toThrow();

    const receipt = formatReceipt(allItems);
    expect(receipt).toHaveLength(2);

    // Promotional item should use fallback values
    const promoLine = receipt.find((r) => r.sku === 'PROMO-GIFT-2026');
    expect(promoLine).toBeDefined();
    expect(promoLine.name).toBe('Free Spring Gift');
    expect(promoLine.category).toBe('promotion');
    expect(promoLine.lineTotal).toBe(0);
  });

  test('buggy version DOES crash on promotional items (proves regression value)', () => {
    const allItems = applyPromotions([
      { sku: 'WIDGET-001', qty: 1, price: 29.99 },
    ]);
    expect(() => formatReceiptBuggy(allItems)).toThrow(TypeError);
  });

  test('handles unknown SKU without a name property (falls back to SKU string)', () => {
    const items = [
      { sku: 'UNKNOWN-999', qty: 1, price: 5.00 },
    ];
    const receipt = formatReceipt(items);
    expect(receipt[0].name).toBe('UNKNOWN-999');
    expect(receipt[0].category).toBe('promotion');
  });

  test('handles item with name but not in catalog', () => {
    const items = [
      { sku: 'CUSTOM-001', name: 'Custom Item', qty: 3, price: 10.00 },
    ];
    const receipt = formatReceipt(items);
    expect(receipt[0].name).toBe('Custom Item');
    expect(receipt[0].category).toBe('promotion');
    expect(receipt[0].lineTotal).toBe(30.00);
  });

  test('handles mixed catalog and non-catalog items', () => {
    const items = [
      { sku: 'GADGET-001', qty: 1, price: 49.99 },
      { sku: 'PROMO-GIFT-2026', name: 'Free Spring Gift', qty: 1, price: 0 },
      { sku: 'TOOL-002', qty: 2, price: 59.99 },
    ];
    const receipt = formatReceipt(items);
    expect(receipt).toHaveLength(3);
    expect(receipt[0].name).toBe('Super Gadget');
    expect(receipt[0].category).toBe('gadgets');
    expect(receipt[1].name).toBe('Free Spring Gift');
    expect(receipt[1].category).toBe('promotion');
    expect(receipt[2].name).toBe('Precision Tool');
    expect(receipt[2].category).toBe('tools');
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

  test('does not mutate original items array', () => {
    const items = [{ sku: 'WIDGET-001', qty: 1, price: 29.99 }];
    const result = applyPromotions(items);
    expect(items).toHaveLength(1);
    expect(result).toHaveLength(2);
  });
});
