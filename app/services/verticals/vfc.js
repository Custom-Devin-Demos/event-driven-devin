const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * VF Corporation product catalog — unified storefront across iconic
 * outdoor & apparel brands (The North Face, Vans, Timberland, etc.)
 */
const CATALOG = [
  { id: 'TNF-NUPTSE', name: 'The North Face\u00AE 1996 Retro Nuptse Jacket', price: 320.00, category: 'outerwear', brand: 'The North Face' },
  { id: 'TNF-DENALI', name: 'The North Face\u00AE Denali Fleece Jacket', price: 179.00, category: 'outerwear', brand: 'The North Face' },
  { id: 'VAN-OLDSKL', name: 'Vans\u00AE Old Skool Sneakers', price: 70.00, category: 'footwear', brand: 'Vans' },
  { id: 'VAN-SK8HI', name: 'Vans\u00AE Sk8-Hi Sneakers', price: 80.00, category: 'footwear', brand: 'Vans' },
  { id: 'TIM-6INCH', name: 'Timberland\u00AE 6-Inch Premium Waterproof Boots', price: 198.00, category: 'footwear', brand: 'Timberland' },
  { id: 'JAN-SUPER', name: 'JanSport\u00AE SuperBreak Backpack', price: 45.00, category: 'bags', brand: 'JanSport' },
  { id: 'SMW-CREW', name: 'Smartwool\u00AE Hike Light Cushion Crew Socks', price: 24.00, category: 'accessories', brand: 'Smartwool' },
  { id: 'KIP-CITYZIP', name: 'Kipling\u00AE City Zip Crossbody Bag', price: 89.00, category: 'bags', brand: 'Kipling' },
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
 * Active promotions — "VF Family Member exclusive" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-VFFAM-2026', name: 'VF Family\u2122 Member Gift', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 250) return { rate: 0.15, label: '15% off orders $250+' };
  if (subtotal >= 150) return { rate: 0.10, label: '10% off orders $150+' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges promotional items into the order line items.
 */
function applyPromotions(items) {
  return [...items, ...ACTIVE_PROMOTIONS];
}

/**
 * Computes the final order total.
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
    discountLabel: discount.label,
    total: Math.round((subtotal + tax - discountAmount) * 100) / 100,
    currency: taxConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 * BUG: PROMO-VFFAM-2026 is not in CATALOG, so product.name crashes.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,
      category: product.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes a VF Corporation storefront checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing VF Corporation checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'vfc-ecommerce',
    route: '/api/vfc/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyPromotions(orderData.items);

    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeOrderTotal(finalSubtotal, orderData.region);
    const receipt = formatReceipt(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/vfc/checkout',
      source: 'vfc-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/vfc/checkout',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      tax: result.tax,
      discount: result.discount,
      discountLabel: result.discountLabel,
      receipt,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/vfc/checkout',
      errorClass: error.name,
      source: 'vfc-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/vfc/checkout',
      error: 'true',
    });

    logger.error('VF Corporation checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'vfc-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/vfc/checkout',
        service: 'vfc-ecommerce',
        source: 'vfc-storefront',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        region: orderData.region,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/vfc.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'vfc',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'vfc-ecommerce',
      verticalLabel: 'VF Corporation Checkout',
      tags: [
        { key: 'route', value: '/api/vfc/checkout' },
        { key: 'service', value: 'vfc-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'vfc-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from VF Corporation checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
