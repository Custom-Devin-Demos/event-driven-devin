const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Staples.ca storefront catalog.
 * Prices in CAD, matching the staples.ca cart/checkout experience.
 */
const PRODUCTS = [
  {
    sku: 'CH-2841-BRN',
    name: 'Staples Ardfield Fabric Task Chair, Brown',
    price: 189.99,
    category: 'Furniture',
  },
  {
    sku: 'NB-5510-3PK',
    name: 'Staples 1-Subject Spiral Notebook, 3/Pack',
    price: 8.49,
    category: 'Notebooks & Pads',
  },
  {
    sku: 'PEN-0071-12',
    name: 'Staples Gel Ink Retractable Pens, Black, 12/Pack',
    price: 14.29,
    category: 'Writing Supplies',
  },
];

/**
 * Sales-tax profiles by Canadian province code. The checkout summary
 * uses the shipping province to apply the correct GST/PST/HST split.
 */
const PROVINCE_TAX = {
  ON: { label: 'HST', rate: 0.13 },
  BC: { label: 'GST + PST', rate: 0.12 },
  AB: { label: 'GST', rate: 0.05 },
  QC: { label: 'GST + QST', rate: 0.14975 },
  NS: { label: 'HST', rate: 0.15 },
  MB: { label: 'GST + RST', rate: 0.12 },
};

/**
 * Free-shipping threshold in CAD (Staples.ca ships free on orders $45+).
 */
const FREE_SHIPPING_THRESHOLD = 45;
const EXPRESS_SHIPPING = 9.99;

/**
 * Normalize an incoming province value to the canonical lookup key.
 */
function normalizeProvince(province) {
  return String(province || '').trim().toLowerCase();
}

/**
 * Build the cart line items from the incoming SKUs.
 */
function buildLineItems(items) {
  return items.map((item) => {
    const product = PRODUCTS.find((p) => p.sku === item.sku);
    if (!product) return null;
    const qty = item.qty || 1;
    return {
      sku: product.sku,
      name: product.name,
      qty,
      unitPrice: product.price,
    };
  }).filter(Boolean);
}

/**
 * Compute the order summary: subtotal, shipping, tax and order total.
 */
function computeOrderSummary(lineItems, shippingMethod, province) {
  const subtotal = lineItems.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);

  const shipping = shippingMethod === 'express'
    ? EXPRESS_SHIPPING
    : (subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : EXPRESS_SHIPPING);

  const taxProfile = PROVINCE_TAX[normalizeProvince(province)];
  const tax = (subtotal + shipping) * taxProfile.rate;
  const total = subtotal + shipping + tax;

  return {
    itemCount: lineItems.reduce((sum, li) => sum + li.qty, 0),
    subtotal: Math.round(subtotal * 100) / 100,
    shipping,
    taxLabel: taxProfile.label,
    tax: Math.round(tax * 100) / 100,
    total: Math.round(total * 100) / 100,
    currency: 'CAD',
  };
}

/**
 * Process a Staples.ca secure checkout ("Place Order").
 */
async function processCheckout(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Staples checkout', {
    orderId,
    itemCount: data.items ? data.items.length : 0,
    province: data.province,
    service: 'staples-checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const lineItems = buildLineItems(data.items || []);
    if (lineItems.length === 0) {
      const err = new Error('Your cart is empty. Add at least one item to check out.');
      err.name = 'EmptyCartError';
      err.code = 'EMPTY_CART';
      throw err;
    }

    const summary = computeOrderSummary(lineItems, data.shippingMethod, data.province);

    const duration = Date.now() - startTime;
    incrementMetric('staples_checkout.success', { route: '/api/cd83ac3c/checkout' });
    recordTiming('staples_checkout.latency', duration, { route: '/api/cd83ac3c/checkout' });

    return {
      success: true,
      orderId,
      items: lineItems,
      ...summary,
      shippingMethod: data.shippingMethod || 'standard',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('staples_checkout.failure', { route: '/api/cd83ac3c/checkout', errorClass: error.name });
    recordTiming('staples_checkout.latency', duration, { route: '/api/cd83ac3c/checkout', error: 'true' });
    logger.error('Staples checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/cd83ac3c/checkout',
        service: 'staples-checkout',
      },
      extra: { orderId, itemCount: data.items ? data.items.length : 0, province: data.province },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/cd83ac3c.js \u2014 computeOrderSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'staples-checkout',
      verticalLabel: 'Staples.ca Secure Checkout',
      customer: 'cd83ac3c',
      tags: [
        { key: 'route', value: '/api/cd83ac3c/checkout' },
        { key: 'service', value: 'staples-checkout' },
      ],
      extra: { orderId, itemCount: data.items ? data.items.length : 0, province: data.province },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'staples-checkout@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from Staples checkout error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = { processCheckout, PRODUCTS, PROVINCE_TAX };
