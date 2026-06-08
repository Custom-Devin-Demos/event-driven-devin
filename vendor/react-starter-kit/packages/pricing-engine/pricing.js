'use strict';

/**
 * Pro volume discount tiers + order total math.
 *
 * Mirrors `packages/pricing-engine/pricing.ts` from COG-GTM/react-starter-kit.
 */
const { TAX_REGIONS } = require('./catalog');

/**
 * Looks up the Pro volume discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 2000) return { rate: 0.1, label: '10% Pro volume discount ($2,000+)' };
  if (subtotal >= 500) return { rate: 0.05, label: '5% Pro volume discount ($500+)' };
  return { rate: 0, label: 'None' };
}

/**
 * Computes the final order total for a subtotal in a given tax region.
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
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    discountLabel: discount.label,
    total: Math.round((subtotal + tax - discountAmount) * 100) / 100,
    currency: taxConfig.currency,
  };
}

module.exports = { getApplicableDiscount, computeOrderTotal };
