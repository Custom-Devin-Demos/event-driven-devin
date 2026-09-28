const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Rogers product catalog — wireless devices, plans, and add-ons.
 * Price is the monthly CAD amount (device financing / plan / add-on).
 */
const CATALOG = [
  { id: 'RGR-DEV-IP17P-256', name: 'iPhone 17 Pro 256 GB', price: 56.25, category: 'device', term: '24-mo Rogers Financing' },
  { id: 'RGR-DEV-S26U-512', name: 'Samsung Galaxy S26 Ultra 512 GB', price: 62.50, category: 'device', term: '24-mo Rogers Financing' },
  { id: 'RGR-DEV-PX10P-128', name: 'Google Pixel 10 Pro 128 GB', price: 45.84, category: 'device', term: '24-mo Rogers Financing' },
  { id: 'RGR-PLN-5GP-100', name: '5G+ Infinite Ultimate — 100 GB', price: 95.00, category: 'plan', term: 'Month-to-month' },
  { id: 'RGR-PLN-5G-60', name: '5G Infinite Essentials — 60 GB', price: 75.00, category: 'plan', term: 'Month-to-month' },
  { id: 'RGR-ADD-APPLECARE', name: 'AppleCare+ for iPhone', price: 13.99, category: 'add-on', term: 'Monthly' },
  { id: 'RGR-ADD-RLH', name: 'Roam Like Home — US & Mexico', price: 15.00, category: 'add-on', term: 'Monthly' },
  { id: 'RGR-ADD-DEVPROT', name: 'Rogers Device Protection', price: 12.00, category: 'add-on', term: 'Monthly' },
];

/**
 * Provincial tax configuration
 */
const PROVINCES = {
  ON: { taxRate: 0.13, taxLabel: 'HST', currency: 'CAD' },
  QC: { taxRate: 0.14975, taxLabel: 'GST+QST', currency: 'CAD' },
  BC: { taxRate: 0.12, taxLabel: 'GST+PST', currency: 'CAD' },
  AB: { taxRate: 0.05, taxLabel: 'GST', currency: 'CAD' },
  NS: { taxRate: 0.14, taxLabel: 'HST', currency: 'CAD' },
  MB: { taxRate: 0.12, taxLabel: 'GST+RST', currency: 'CAD' },
};

/**
 * Active promotions — applied server-side for the fall 2026 launch campaign.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-RSAT-2026', name: 'Rogers Satellite — included with 5G+ Infinite', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 150) return { rate: 0.10, label: 'Infinite bundle savings (10%)' };
  if (subtotal >= 100) return { rate: 0.05, label: 'Infinite bundle savings (5%)' };
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
function computeOrderTotal(subtotal, province) {
  const taxConfig = PROVINCES[province];
  if (!taxConfig) {
    throw Object.assign(new Error(`Unknown province: ${province}`), { code: 'INVALID_PROVINCE' });
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
    taxLabel: taxConfig.taxLabel,
    currency: taxConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 * BUG: PROMO-RSAT-2026 is not in CATALOG, so product.name crashes.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,
      category: product.category,
      term: product.term,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes a Rogers wireless checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Rogers checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'rogers-ecommerce',
    route: '/api/adbe35bc/checkout',
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

    const result = computeOrderTotal(finalSubtotal, orderData.province);
    const receipt = formatReceipt(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/adbe35bc/checkout',
      source: 'rogers-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/adbe35bc/checkout',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      tax: result.tax,
      taxLabel: result.taxLabel,
      discount: result.discount,
      discountLabel: result.discountLabel,
      currency: result.currency,
      receipt,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/adbe35bc/checkout',
      errorClass: error.name,
      source: 'rogers-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/adbe35bc/checkout',
      error: 'true',
    });

    logger.error('Rogers checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'rogers-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/adbe35bc/checkout',
        service: 'rogers-ecommerce',
        source: 'rogers-storefront',
        alert_path: 'instant',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        province: orderData.province,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/adbe35bc.js — formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      customer: 'adbe35bc',
      service: 'rogers-ecommerce',
      verticalLabel: 'Rogers Checkout',
      tags: [
        { key: 'route', value: '/api/adbe35bc/checkout' },
        { key: 'service', value: 'rogers-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'rogers-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Rogers checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, getApplicableDiscount, CATALOG, PROVINCES };
