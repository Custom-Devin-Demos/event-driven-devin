const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

/**
 * Size variants as published by the catalog feed, keyed by size code.
 */
const STYLES = [
  {
    styleId: '8688977',
    itemNumber: '11150327',
    title: 'Nordstrom Cashmere Crewneck Sweater',
    priceCents: 16900,
    currency: 'USD',
    variants: {
      XXS: { sku: '11150327-XXS' },
      XS: { sku: '11150327-XS' },
      S: { sku: '11150327-S' },
      M: { sku: '11150327-M' },
      L: { sku: '11150327-L' },
      XL: { sku: '11150327-XL' },
      XXL: { sku: '11150327-XXL' },
    },
  },
];

function formatUSD(cents, currency) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/**
 * Add an apparel style to the shopper's bag.
 */
async function addToBag(bagData, options = {}) {
  const startTime = Date.now();
  const bagId = uuidv4();

  logger.info('Adding apparel item to bag', {
    bagId,
    styleId: bagData.styleId,
    size: bagData.size,
    quantity: bagData.quantity,
    service: 'bag-api',
    route: '/api/oncall/apparel/bag',
  });

  try {
    const style = STYLES.find((item) => item.styleId === bagData.styleId);
    if (!style) {
      const error = new Error(`Unknown style: ${bagData.styleId}`);
      error.code = 'STYLE_NOT_FOUND';
      throw error;
    }

    const quantity = Math.min(Math.max(parseInt(bagData.quantity, 10) || 1, 1), 5);
    const variant = style.variants[bagData.size];
    const line = { sku: variant.sku };
    const subtotalCents = style.priceCents * quantity;
    const duration = Date.now() - startTime;

    incrementMetric('bag.add.success', {
      route: '/api/oncall/apparel/bag',
    });
    recordTiming('bag.add.latency', duration, {
      route: '/api/oncall/apparel/bag',
    });

    return {
      success: true,
      bagId,
      styleId: style.styleId,
      sku: line.sku,
      size: bagData.size,
      color: bagData.color,
      quantity,
      subtotal: subtotalCents / 100,
      subtotalFormatted: formatUSD(subtotalCents, style.currency),
      addedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('bag.add.failure', {
      route: '/api/oncall/apparel/bag',
      errorClass: error.name,
    });
    recordTiming('bag.add.latency', duration, {
      route: '/api/oncall/apparel/bag',
      error: 'true',
    });

    logger.error('Add to bag failed', {
      bagId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      styleId: bagData.styleId,
      size: bagData.size,
      quantity: bagData.quantity,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/oncall/apparel/bag',
        service: 'bag-api',
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: {
        bagId,
        styleId: bagData.styleId,
        size: bagData.size,
        quantity: bagData.quantity,
      },
    });

    throw error;
  }
}

module.exports = { addToBag, STYLES };
