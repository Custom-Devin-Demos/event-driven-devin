'use strict';

/**
 * Canonical Home Depot merchandise catalog.
 *
 * Mirrors `packages/pricing-engine/catalog.ts` from COG-GTM/react-starter-kit.
 * See ./VENDORED.md for how this CommonJS build is produced and kept in sync.
 */
const CATALOG = [
  { sku: 'HD-1001-DRILL', name: 'DEWALT 20V MAX Cordless Drill/Driver Kit', category: 'tools', unitPrice: 159.0 },
  { sku: 'HD-1002-SAW', name: 'RYOBI ONE+ 18V Circular Saw', category: 'tools', unitPrice: 99.0 },
  { sku: 'HD-2001-PAINT', name: 'BEHR Premium Plus Interior Paint (1 gal)', category: 'paint', unitPrice: 34.98 },
  { sku: 'HD-2002-PRIMER', name: 'KILZ Original Multi-Surface Primer (1 gal)', category: 'paint', unitPrice: 24.98 },
  { sku: 'HD-3001-LUMBER', name: '2 in. x 4 in. x 8 ft. Prime Lumber', category: 'building-materials', unitPrice: 4.28 },
  { sku: 'HD-3002-PLYWOOD', name: '3/4 in. 4 ft. x 8 ft. Sanded Plywood', category: 'building-materials', unitPrice: 58.0 },
  { sku: 'HD-4001-WATER', name: 'Rheem Performance 50 Gal. Water Heater', category: 'plumbing', unitPrice: 549.0 },
  { sku: 'HD-4002-FAUCET', name: 'MOEN Adler Single-Handle Kitchen Faucet', category: 'plumbing', unitPrice: 89.0 },
  { sku: 'HD-5001-LED', name: 'Philips 60W LED Soft White Bulb (4-Pack)', category: 'electrical', unitPrice: 12.97 },
  { sku: 'HD-6001-MULCH', name: 'Vigoro 2 cu. ft. Bark Mulch', category: 'garden', unitPrice: 3.33 },
];

/**
 * Catalog indexed by SKU for O(1) lookups during receipt formatting.
 */
const CATALOG_BY_SKU = Object.fromEntries(CATALOG.map((product) => [product.sku, product]));

/**
 * Per-region tax configuration.
 */
const TAX_REGIONS = {
  US: { taxRate: 0.0825, currency: 'USD' },
  CA: { taxRate: 0.13, currency: 'CAD' },
  MX: { taxRate: 0.16, currency: 'MXN' },
};

module.exports = { CATALOG, CATALOG_BY_SKU, TAX_REGIONS };
