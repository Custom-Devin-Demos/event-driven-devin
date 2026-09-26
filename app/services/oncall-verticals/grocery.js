const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

/**
 * Cart contents for the PC Express demo storefront.
 */
const CART_ITEMS = [
  {
    sku: '21004836_EA',
    name: 'Ginger + Lemon Juice Shots Juice Blend with Other Ingredients for Immune Support',
    priceCents: 1000,
    quantity: 1,
  },
  {
    sku: '20083157_KG',
    name: 'Ground Chicken',
    priceCents: 900,
    quantity: 2,
  },
  {
    sku: '20135377001_KG',
    name: 'Granny Smith Apples, 3 lb Bag',
    priceCents: 1250,
    quantity: 1,
  },
  {
    sku: '20812144_EA',
    name: 'Egg Whites',
    priceCents: 950,
    quantity: 1,
  },
];

/**
 * Weekly PC Optimum offers for the demo storefront, keyed by sku. Entries are
 * loaded from the weekly offer catalog refresh.
 */
const OPTIMUM_OFFERS = [
  { sku: '21004836_EA', type: 'points', reward: { points: 1500, minQty: 1 } },
  { sku: '20083157_KG', type: 'points', reward: { points: 1000, minQty: 2 } },
  { sku: '20812144_EA', type: 'points', points: 2000 },
];

const HST_RATE = 0.13;
const BOTTLE_DEPOSIT_CENTS = 0;
const PICKUP_FEE_CENTS = 0;

function lookupItem(sku) {
  return CART_ITEMS.find((i) => i.sku === sku) || null;
}

function lookupOffer(sku) {
  return OPTIMUM_OFFERS.find((o) => o.sku === sku) || null;
}

/**
 * Calculate the order total: merchandise subtotal, PC Optimum points earned,
 * deposit, tax and pickup fee.
 */
function calculateOrderTotal(lines) {
  let subtotalCents = 0;
  let optimumPoints = 0;

  for (const line of lines) {
    subtotalCents += line.item.priceCents * line.quantity;
  }

  for (const line of lines) {
    const offer = lookupOffer(line.item.sku);
    if (offer && line.quantity >= offer.reward.minQty) {
      optimumPoints += offer.reward.points;
    }
  }

  const taxCents = Math.round((subtotalCents + BOTTLE_DEPOSIT_CENTS) * HST_RATE);
  const totalCents = subtotalCents + BOTTLE_DEPOSIT_CENTS + taxCents + PICKUP_FEE_CENTS;

  return { subtotalCents, optimumPoints, taxCents, totalCents };
}

/**
 * Place a PC Express pickup order.
 */
async function checkoutOrder(orderData, options = {}) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Checking out grocery order', {
    orderId,
    storeId: orderData.storeId,
    lineCount: Array.isArray(orderData.lines) ? orderData.lines.length : 0,
    pickupSlot: orderData.pickupSlot,
    service: 'order-api',
    route: '/api/oncall/grocery/checkout',
  });

  try {
    const storeId = orderData.storeId || '1039';
    const requested = Array.isArray(orderData.lines) ? orderData.lines : [];

    const lines = requested.map((line) => {
      const item = lookupItem(line.sku);
      if (!item) {
        const err = new Error(`Unknown item: ${line.sku}`);
        err.code = 'ITEM_NOT_FOUND';
        throw err;
      }
      const quantity = Math.min(Math.max(parseInt(line.quantity, 10) || 1, 1), 24);
      return { item, quantity };
    });

    const totals = calculateOrderTotal(lines);
    const duration = Date.now() - startTime;

    incrementMetric('checkout.order.success', {
      route: '/api/oncall/grocery/checkout',
      storeId,
    });
    recordTiming('checkout.order.latency', duration, {
      route: '/api/oncall/grocery/checkout',
    });

    return {
      success: true,
      orderId,
      subtotal: totals.subtotalCents / 100,
      optimumPoints: totals.optimumPoints,
      total: totals.totalCents / 100,
      pickupWindow: 'Tomorrow 8:00am\u20139:00am',
      store: 'Loblaws Dupont Street',
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (!error.code) {
      error.code = 'ORDER_TOTAL_FAILED';
    }

    incrementMetric('checkout.order.failure', {
      route: '/api/oncall/grocery/checkout',
      errorClass: error.name,
    });
    recordTiming('checkout.order.latency', duration, {
      route: '/api/oncall/grocery/checkout',
      error: 'true',
    });

    logger.error('Grocery checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      storeId: orderData.storeId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/oncall/grocery/checkout',
        service: 'order-api',
        storeId: orderData.storeId,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { orderId, pickupSlot: orderData.pickupSlot },
    });

    throw error;
  }
}

module.exports = { checkoutOrder, CART_ITEMS, OPTIMUM_OFFERS };
