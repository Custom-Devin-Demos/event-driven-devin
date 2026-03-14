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

    const region = TAX_REGIONS[null];
    const taxRate = region.taxRate;
    const tax = order.subtotal * taxRate;
    const total = order.subtotal + tax;

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
      total: Math.round(total * 100) / 100,
      tax: Math.round(tax * 100) / 100,
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
