const express = require('express');
const { v4: uuidv4 } = require('uuid');
const logger = require('../telemetry/logger');
const { incrementMetric, recordTiming } = require('../telemetry/datadog');
const { Sentry } = require('../telemetry/sentry');
const { createSessionAndAlert } = require('../services/devin-session');

const router = express.Router();

/**
 * Product catalog for the storefront UI
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

/**
 * Tax region configuration
 */
const TAX_REGIONS = {
  US: { taxRate: 0.08, currency: 'USD' },
  EU: { taxRate: 0.20, currency: 'EUR' },
  UK: { taxRate: 0.20, currency: 'GBP' },
  CA: { taxRate: 0.13, currency: 'CAD' },
};

/**
 * Discount schedule — recently migrated from a flat 10% to a tiered structure.
 * The migration updated the data shape but not all callers.
 */
const DISCOUNT_SCHEDULE = [
  { minSubtotal: 0,   maxSubtotal: 49.99,  rate: 0 },
  { minSubtotal: 50,  maxSubtotal: 99.99,  rate: 0.05 },
  { minSubtotal: 100, maxSubtotal: 199.99, rate: 0.10 },
  { minSubtotal: 200, maxSubtotal: Infinity, rate: 0.15 },
];

/**
 * Active promotions — "free gift with any purchase" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-GIFT-2026', name: 'Free Spring Gift', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 *
 * BUG: This function is correct in isolation, but it's called with the
 * output of a subtotal calculation that can produce 0 (when the cart
 * contains ONLY free promotional items). The `||` operator in the caller
 * treats 0 as falsy and falls through to a string fallback — same
 * pattern as the Banking vertical's falsy-zero bug, but here it cascades
 * through two more functions before crashing.
 */
function getApplicableDiscount(subtotal) {
  const tier = DISCOUNT_SCHEDULE.find(
    (t) => subtotal >= t.minSubtotal && subtotal <= t.maxSubtotal,
  );
  return tier;
}

/**
 * Merges promotional items into the order line items.
 * Returns a new items array that includes both customer items and promos.
 */
function applyPromotions(items) {
  return [...items, ...ACTIVE_PROMOTIONS];
}

/**
 * Computes the final order total.
 *
 * BUG CHAIN (requires tracing 3 functions to find root cause):
 *
 * 1. applyPromotions() adds a $0 promo item to the cart
 * 2. In the checkout handler, computedSubtotal uses `reduce` on ALL items
 *    (including the $0 promo). If the customer's real items sum to $0
 *    (shouldn't happen normally), or we accidentally compute only the promo
 *    items, the subtotal is 0.
 * 3. The `|| order.subtotal` fallback treats 0 as falsy — same JS gotcha
 *    as Banking. It falls through to order.subtotal which is fine for
 *    normal cases.
 * 4. BUT: the real crash path is different. The `reduce` gives a valid
 *    number (e.g., 29.99). The `||` doesn't trigger. computeOrderTotal
 *    is called with a valid subtotal. getApplicableDiscount returns a
 *    valid tier. Everything works...
 *
 * EXCEPT: The actual bug is that applyPromotions() is called but the
 * promo items have no `sku` field matching PRODUCTS — and later,
 * formatReceipt() (below) tries to look up each item in PRODUCTS by
 * sku to get the category. PRODUCTS.find() returns undefined for the
 * promo SKU, and we access undefined.category → TypeError.
 */
function computeOrderTotal(subtotal, region) {
  const taxConfig = TAX_REGIONS[region];
  if (!taxConfig) {
    throw Object.assign(new Error(`Unknown tax region: ${region}`), { code: 'INVALID_REGION' });
  }
  const tax = subtotal * taxConfig.taxRate;
  const discount = getApplicableDiscount(subtotal);
  const discountAmount = (subtotal + tax) * discount.rate;
  return {
    subtotal,
    tax: Math.round(tax * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    total: Math.round((subtotal + tax - discountAmount) * 100) / 100,
    currency: taxConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 *
 * BUG: Iterates over ALL items (including promo items from applyPromotions).
 * Promo items have sku='PROMO-GIFT-2026' which doesn't exist in PRODUCTS.
 * PRODUCTS.find(p => p.id === item.sku) returns undefined.
 * Then we access undefined.category → TypeError!
 *
 * The crash happens HERE, but the root cause is in applyPromotions()
 * adding items with SKUs that don't exist in PRODUCTS.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = PRODUCTS.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,       // TypeError: Cannot read properties of undefined (reading 'name')
      category: product.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * GET /api/products — returns the product catalog
 */
router.get('/api/products', (_req, res) => {
  res.json({ products: PRODUCTS });
});

/**
 * POST /api/storefront/checkout — processes a storefront checkout order.
 */
router.post('/api/storefront/checkout', async (req, res) => {
  const startTime = Date.now();
  const orderId = uuidv4();

  const order = {
    orderId,
    userId: req.body.userId || 'anonymous',
    items: req.body.items || [{ sku: 'WIDGET-001', qty: 1, price: 29.99 }],
    subtotal: req.body.subtotal || 29.99,
    region: req.body.region || 'US',
    persona: req.body.persona || 'buyer_1',
  };

  logger.info('Processing checkout', {
    orderId,
    userId: order.userId,
    subtotal: order.subtotal,
    scenario: 'checkout-regression',
    route: '/api/storefront/checkout',
    source: 'storefront-ui',
  });

  try {
    // Small delay to simulate processing
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    // Apply active promotions (adds free gift items to the order)
    const allItems = applyPromotions(order.items);

    // Compute subtotal from all items (customer + promo)
    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || order.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeOrderTotal(finalSubtotal, order.region);

    // Build receipt with line-item details for confirmation
    // BUG: formatReceipt iterates allItems which includes promo items
    // whose SKU doesn't exist in PRODUCTS → crash on product.name
    const receipt = formatReceipt(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/storefront/checkout',
      persona: order.persona,
      source: 'storefront-ui',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/storefront/checkout',
      persona: order.persona,
    });

    return res.json({
      success: true,
      orderId,
      total: result.total,
      tax: result.tax,
      discount: result.discount,
      receipt,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    });
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/storefront/checkout',
      errorClass: error.name,
      persona: order.persona,
      source: 'storefront-ui',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/storefront/checkout',
      persona: order.persona,
      error: 'true',
    });

    logger.error('Checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      scenario: 'checkout-regression',
      userId: order.userId,
      source: 'storefront-ui',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/storefront/checkout',
        scenario: 'checkout-regression',
        persona: order.persona,
        source: 'storefront-ui',
      },
      extra: {
        orderId,
        userId: order.userId,
        subtotal: order.subtotal,
        region: order.region,
      },
    });

    // Immediately trigger Devin session + Slack alert on checkout error (non-blocking)
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/routes/storefront.js — POST /api/storefront/checkout',
      errorType: error.name || 'Error',
      errorValue: error.message,
      tags: [
        { key: 'route', value: '/api/storefront/checkout' },
        { key: 'scenario', value: 'checkout-regression' },
        { key: 'source', value: 'storefront-ui' },
      ],
      extra: { orderId, userId: order.userId, subtotal: order.subtotal, region: order.region },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'acme-checkout@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from checkout error', { error: err.message });
    });

    const statusCode = error.code === 'PAYMENT_TIMEOUT' ? 504
      : error.code === 'INVENTORY_CONFLICT' ? 409
      : 500;

    return res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
