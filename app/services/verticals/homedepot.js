const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Shared checkout pricing & receipt engine.
 *
 * This is the `@repo/pricing-engine` package, which lives in a SEPARATE repo
 * (COG-GTM/react-starter-kit, packages/pricing-engine) and is vendored here as
 * a CommonJS build (see vendor/react-starter-kit/packages/pricing-engine/VENDORED.md).
 * The Home Depot storefront depends on it for catalog lookups, tax/discount
 * math and receipt formatting — so a defect in that shared library surfaces in
 * this checkout flow through the import chain:
 *
 *   homedepot.js → buildCheckoutReceipt() → formatLineItems()  [pricing-engine]
 */
const pricingEngine = require('../../../vendor/react-starter-kit/packages/pricing-engine');

const { CATALOG, buildCheckoutReceipt } = pricingEngine;

/**
 * Active loyalty rewards — the "Pro Xtra Member" perk applied server-side so it
 * appears on the order confirmation. Note this SKU is a loyalty perk and is
 * intentionally NOT part of the merchandise catalog owned by the pricing engine.
 */
const ACTIVE_LOYALTY_REWARDS = [
  { sku: 'HD-PROXTRA-REWARD', name: 'Pro Xtra Member Reward', price: 0, qty: 1 },
];

/**
 * Merges loyalty reward line items into the order.
 */
function applyLoyaltyRewards(items) {
  return [...items, ...ACTIVE_LOYALTY_REWARDS];
}

/**
 * Processes a Home Depot checkout order.
 *
 * Pricing, discounts and receipt formatting are delegated to the shared
 * @repo/pricing-engine library imported above.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Home Depot checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'homedepot-ecommerce',
    route: '/api/homedepot/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyLoyaltyRewards(orderData.items);

    // Delegate pricing + receipt formatting to the shared pricing engine.
    // formatLineItems() resolves each SKU against the catalog; the loyalty
    // reward SKU is not a catalog product, which is where the bug surfaces.
    const { lineItems, totals } = buildCheckoutReceipt({
      items: allItems,
      region: orderData.region,
    });

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/homedepot/checkout',
      source: 'homedepot-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/homedepot/checkout',
    });

    return {
      success: true,
      orderId,
      total: totals.total,
      tax: totals.tax,
      discount: totals.discount,
      discountLabel: totals.discountLabel,
      currency: totals.currency,
      receipt: lineItems,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/homedepot/checkout',
      errorClass: error.name,
      source: 'homedepot-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/homedepot/checkout',
      error: 'true',
    });

    logger.error('Home Depot checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'homedepot-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/homedepot/checkout',
        service: 'homedepot-ecommerce',
        source: 'homedepot-storefront',
        package: '@repo/pricing-engine',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        region: orderData.region,
        importChain: 'homedepot.js -> @repo/pricing-engine/receipt.ts -> formatLineItems',
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'COG-GTM/react-starter-kit \u2192 packages/pricing-engine/receipt.ts \u2014 formatLineItems (imported by app/services/verticals/homedepot.js)',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'homedepot-ecommerce',
      verticalLabel: 'Home Depot Checkout',
      tags: [
        { key: 'route', value: '/api/homedepot/checkout' },
        { key: 'service', value: 'homedepot-ecommerce' },
        { key: 'root-cause-repo', value: 'COG-GTM/react-starter-kit' },
        { key: 'root-cause-package', value: '@repo/pricing-engine' },
        { key: 'root-cause-file', value: 'packages/pricing-engine/receipt.ts' },
      ],
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        importChain: 'homedepot.js \u2192 buildCheckoutReceipt \u2192 formatLineItems',
        rootCause: 'The TypeError originates in the shared @repo/pricing-engine library, which lives in a different repo (COG-GTM/react-starter-kit). The Home Depot service imports it via vendor/react-starter-kit/packages/pricing-engine. Trace the import chain into packages/pricing-engine/receipt.ts and patch the root cause there.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'homedepot-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Home Depot checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, applyLoyaltyRewards, CATALOG };
