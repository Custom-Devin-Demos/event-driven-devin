const { v4: uuidv4 } = require('uuid');
const { isScenarioActive, getScenario } = require('../incidentModes');
const logger = require('../telemetry/logger');
const { incrementMetric, recordTiming } = require('../telemetry/datadog');
const { Sentry } = require('../telemetry/sentry');

// Custom error classes for realistic stack traces
class PaymentGatewayTimeoutError extends Error {
  constructor(message) {
    super(message || 'Payment gateway timed out after 30000ms');
    this.name = 'PaymentGatewayTimeoutError';
    this.code = 'PAYMENT_TIMEOUT';
  }
}

class InventoryReservationError extends Error {
  constructor(message) {
    super(message || 'Inventory reservation conflict: item already reserved by another session');
    this.name = 'InventoryReservationError';
    this.code = 'INVENTORY_CONFLICT';
  }
}

/**
 * Calculate tax for an order based on the customer's region.
 * Falls back to the default US tax rate if the region is unknown.
 */
function calculateTax(order) {
  const DEFAULT_TAX_RATE = 0.08;

  const taxRegions = {
    US: { taxRate: 0.08 },
    EU: { taxRate: 0.20 },
    UK: { taxRate: 0.20 },
    CA: { taxRate: 0.13 },
  };

  const regionKey = order.region || 'US';
  const region = taxRegions[regionKey];

  if (!region) {
    logger.warn('Unknown tax region, using default rate', {
      region: regionKey,
      defaultTaxRate: DEFAULT_TAX_RATE,
      orderId: order.orderId,
    });
    return order.subtotal * DEFAULT_TAX_RATE;
  }

  return order.subtotal * region.taxRate;
}

/**
 * Process a checkout request
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();
  const scenario = getScenario();

  const order = {
    orderId,
    userId: orderData.userId || 'anonymous',
    items: orderData.items || [{ sku: 'WIDGET-001', qty: 1, price: 29.99 }],
    subtotal: orderData.subtotal || 29.99,
    region: orderData.region || 'US',
    persona: orderData.persona || 'buyer_1',
    scenario,
  };

  logger.info('Processing checkout', {
    orderId,
    userId: order.userId,
    subtotal: order.subtotal,
    scenario,
    route: '/checkout',
  });

  try {
    // Simulate slow-db scenario
    if (isScenarioActive('slow-db')) {
      const delay = 1500 + Math.random() * 1500; // 1.5 to 3 seconds
      await new Promise((resolve) => setTimeout(resolve, delay));
      logger.warn('Slow database query detected', {
        orderId,
        delayMs: Math.round(delay),
        scenario: 'slow-db',
      });
    }

    // Simulate dependency-timeout scenario
    if (isScenarioActive('dependency-timeout')) {
      if (Math.random() < 0.3) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        throw new PaymentGatewayTimeoutError();
      }
    }

    // Simulate checkout-regression scenario (the "bad deploy" story)
    if (isScenarioActive('checkout-regression')) {
      // Intermittent errors at ~40% rate when regression is active
      if (Math.random() < 0.15) {
        throw new InventoryReservationError();
      }
    }

    // Calculate tax (may throw in checkout-regression scenario)
    const tax = calculateTax(order);
    const total = order.subtotal + tax;

    // Small random delay to simulate normal processing
    await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 150));

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/checkout',
      persona: order.persona,
    });
    recordTiming('checkout.latency', duration, {
      route: '/checkout',
      persona: order.persona,
    });

    logger.info('Checkout completed', {
      orderId,
      total,
      tax,
      durationMs: duration,
      scenario,
    });

    return {
      success: true,
      orderId,
      total: Math.round(total * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/checkout',
      errorClass: error.name,
      persona: order.persona,
    });
    recordTiming('checkout.latency', duration, {
      route: '/checkout',
      persona: order.persona,
      error: 'true',
    });

    logger.error('Checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      scenario,
      userId: order.userId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/checkout',
        scenario,
        persona: order.persona,
      },
      extra: {
        orderId,
        userId: order.userId,
        subtotal: order.subtotal,
        region: order.region,
      },
    });

    throw error;
  }
}

module.exports = { processCheckout, PaymentGatewayTimeoutError, InventoryReservationError };
