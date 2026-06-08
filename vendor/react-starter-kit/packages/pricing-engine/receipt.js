'use strict';

/**
 * Receipt formatting + checkout assembly.
 *
 * Mirrors `packages/pricing-engine/receipt.ts` from COG-GTM/react-starter-kit.
 */
const { CATALOG_BY_SKU } = require('./catalog');
const { computeOrderTotal } = require('./pricing');

/**
 * Expands each cart line into a printable receipt row by resolving the SKU
 * against the shared catalog for display name and category.
 *
 * Every SKU passed in is expected to be present in CATALOG_BY_SKU.
 */
function formatLineItems(items) {
  return items.map((item) => {
    const product = CATALOG_BY_SKU[item.sku];
    return {
      sku: item.sku,
      name: product.name,
      category: product.category,
      qty: item.qty,
      lineTotal: Math.round(item.price * item.qty * 100) / 100,
    };
  });
}

/**
 * Builds the full checkout receipt: per-line detail plus monetary totals.
 */
function buildCheckoutReceipt(order) {
  const items = order.items || [];
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const totals = computeOrderTotal(subtotal, order.region);
  const lineItems = formatLineItems(items);
  return { lineItems, totals };
}

module.exports = { formatLineItems, buildCheckoutReceipt };
