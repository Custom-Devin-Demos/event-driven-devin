'use strict';

/**
 * @repo/pricing-engine — shared checkout pricing & receipt library.
 *
 * Vendored CommonJS build of the package that lives in COG-GTM/react-starter-kit
 * (packages/pricing-engine). See ./VENDORED.md.
 */
const { CATALOG, CATALOG_BY_SKU, TAX_REGIONS } = require('./catalog');
const { getApplicableDiscount, computeOrderTotal } = require('./pricing');
const { formatLineItems, buildCheckoutReceipt } = require('./receipt');

module.exports = {
  CATALOG,
  CATALOG_BY_SKU,
  TAX_REGIONS,
  getApplicableDiscount,
  computeOrderTotal,
  formatLineItems,
  buildCheckoutReceipt,
};
