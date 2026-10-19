const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/fluidanalysis/cart';

/**
 * FluidWatch test-kit price books, keyed by price book code.
 */
const PRICE_BOOKS = {
  'NA-DIST-STD': {
    currency: 'USD',
    entries: new Map([
      ['DEOK-B-5', { unitPriceCents: 9750 }],
      ['DEOK-A-5', { unitPriceCents: 14250 }],
      ['NGOK-B-5', { unitPriceCents: 9750 }],
      ['ECAK-A-5', { unitPriceCents: 11900 }],
    ]),
  },
  'NA-DLR-FLUID': {
    currency: 'USD',
    entries: new Map([
      ['DEOK-B-5', { unitPriceCents: 8775 }],
      ['DEOK-A-5', { unitPriceCents: 12825 }],
      ['NGOK-B-5', { unitPriceCents: 8775 }],
      ['ECAK-A-5', { unitPriceCents: 10710 }],
    ]),
  },
};

/**
 * Marketplace buyer accounts and the price book each one is billed from.
 */
const ACCOUNTS = new Map([
  ['CMI-DIST-10233', { name: 'Cummins Sales and Service - Indianapolis', priceBook: 'NA-DIST-STD' }],
  ['CMI-DLR-40817', { name: 'Hoosier Fleet Services', priceBook: 'NA-DLR-FLUIDWATCH' }],
]);

const PRODUCTS = new Map([
  ['DEOK-B-5', { name: 'Diesel Engine Oil Analysis Basic', packSize: 5 }],
  ['DEOK-A-5', { name: 'Diesel Engine Oil Analysis Advanced', packSize: 5 }],
  ['NGOK-B-5', { name: 'Natural Gas Engine Oil Analysis Basic', packSize: 5 }],
  ['ECAK-A-5', { name: 'Engine Coolant Analysis Advanced', packSize: 5 }],
]);

function invalid(message) {
  const error = new Error(message);
  error.code = 'INVALID_CART';
  return error;
}

/**
 * Add a FluidWatch test kit to a marketplace buyer's cart.
 */
async function addKitToCart(cartData, options = {}) {
  const startTime = Date.now();
  const cartLineId = uuidv4();
  const { sku, accountId } = cartData;

  logger.info('Adding FluidWatch kit to cart', {
    cartLineId, sku, accountId, quantity: cartData.quantity, service: 'cart-api', route: ROUTE,
  });

  try {
    const product = PRODUCTS.get(sku);
    if (!product) throw invalid(`Unknown SKU: ${sku}`);
    const account = ACCOUNTS.get(accountId);
    if (!account) throw invalid(`Unknown account: ${accountId}`);
    const quantity = parseInt(cartData.quantity, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw invalid('Quantity must be between 1 and 50');

    const priceBook = PRICE_BOOKS[account.priceBook];
    const entry = priceBook.entries.get(sku);
    const subtotalCents = entry.unitPriceCents * quantity;
    const duration = Date.now() - startTime;

    incrementMetric('cart.add.success', { route: ROUTE });
    recordTiming('cart.add.latency', duration, { route: ROUTE });

    return {
      success: true,
      cartLineId,
      sku,
      name: product.name,
      quantity,
      unitPrice: entry.unitPriceCents / 100,
      subtotal: subtotalCents / 100,
      currency: priceBook.currency,
      addedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('cart.add.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('cart.add.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Add to cart failed', {
      cartLineId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, sku, accountId,
    });
    if (error.code !== 'INVALID_CART') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'cart-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { cartLineId, sku, accountId, quantity: cartData.quantity },
      });
    }
    throw error;
  }
}

module.exports = { addKitToCart, PRICE_BOOKS, ACCOUNTS };
