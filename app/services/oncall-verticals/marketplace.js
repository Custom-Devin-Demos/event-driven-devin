const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

/**
 * Marketplace offers for the demo storefront.
 */
const OFFERS = [
  {
    id: 'OFF-NA221-PHG',
    listingId: '408492471',
    sellerId: 'SELLER-PHILIPS-HHG',
    sellerName: 'Philips-Haushaltsgeraete',
    title: 'Philips Airfryer Serie 2000, 4,2l, RapidAir, Digital, schwarz (NA221/00)',
    priceCents: 7900,
    currency: 'EUR',
    shippingCents: 0,
  },
];

/**
 * Regional fulfilment nodes a seller's stock can sit in. `stock` is the
 * quantity physically available at that node.
 */
const FULFILMENT_NODES = [
  { id: 'de-w1-bad-hersfeld', region: 'DE-HE', stock: 0 },
  { id: 'de-w2-osterfeld', region: 'DE-ST', stock: 0 },
  { id: 'de-w3-donauworth', region: 'DE-BY', stock: 0 },
  { id: 'de-w4-luebbenau', region: 'DE-BB', stock: 0 },
  { id: 'pl-w5-poznan', region: 'PL-WP', stock: 0 },
  { id: 'cz-w6-jirny', region: 'CZ-ST', stock: 0 },
  { id: 'sk-w7-ilava', region: 'SK-TC', stock: 0 },
  { id: 'de-w8-neckarsulm', region: 'DE-BW', stock: 64 },
];

const RESERVATION_DEADLINE_MS = 8000;
const NODE_CALL_LATENCY_MS = [1000, 1250];

/**
 * Simulated round trip to the seller's inventory partner.
 */
function partnerCall(respond) {
  const [minMs, maxMs] = NODE_CALL_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => resolve(respond()), minMs + Math.random() * (maxMs - minMs));
  });
}

/**
 * Read-only availability check at a single fulfilment node
 * (`inventory/v1/availability`). Creates no reservation.
 */
function checkAvailabilityAtNode(node, quantity) {
  return partnerCall(() => ({
    node: node.id,
    canCover: node.stock >= quantity,
    available: node.stock,
  }));
}

/**
 * Reserve stock at a single fulfilment node (`inventory/v1/reserve`).
 */
function reserveAtNode(node, quantity) {
  return partnerCall(() => ({
    node: node.id,
    reserved: node.stock >= quantity,
    available: node.stock,
  }));
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'RESERVATION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function probeAvailability(node, quantity, offer, cartId) {
  const startedAt = Date.now();
  const result = await checkAvailabilityAtNode(node, quantity);
  logger.info('Stock availability probe', {
    cartId,
    sellerId: offer.sellerId,
    node: node.id,
    region: node.region,
    canCover: result.canCover,
    available: result.available,
    durationMs: Date.now() - startedAt,
    service: 'cart-api',
    endpoint: 'inventory/v1/availability',
  });
  return result;
}

/**
 * Reserve the requested quantity for the shopper in two partner round trips:
 * check availability at every fulfilment node in parallel, then place exactly
 * one reservation at the first node that can cover the quantity. Latency is
 * bounded by two round trips regardless of how many nodes the seller has, and a
 * partner failure on any probe is surfaced rather than reported as no stock.
 */
async function reserveStock(offer, quantity, cartId) {
  const availability = await Promise.all(
    FULFILMENT_NODES.map((node) => probeAvailability(node, quantity, offer, cartId)),
  );
  const candidate = FULFILMENT_NODES.find((node, i) => availability[i].canCover);
  if (!candidate) {
    const err = new Error(`No fulfilment node can cover offer ${offer.id}`);
    err.code = 'OUT_OF_STOCK';
    throw err;
  }

  const startedAt = Date.now();
  const attempt = await reserveAtNode(candidate, quantity);
  logger.info('Stock reservation', {
    cartId,
    sellerId: offer.sellerId,
    node: candidate.id,
    region: candidate.region,
    reserved: attempt.reserved,
    durationMs: Date.now() - startedAt,
    service: 'cart-api',
    endpoint: 'inventory/v1/reserve',
  });
  if (!attempt.reserved) {
    const err = new Error(`Fulfilment node ${candidate.id} could not reserve offer ${offer.id}`);
    err.code = 'RESERVATION_REJECTED';
    throw err;
  }
  return { node: candidate.id, reservationRef: `RES-${cartId.slice(0, 8)}` };
}

function lookupOffer(offerId) {
  return OFFERS.find((o) => o.id === offerId) || null;
}

function formatEuro(cents) {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

/**
 * Add a marketplace offer to the shopper's cart.
 */
async function addToCart(cartData, options = {}) {
  const startTime = Date.now();
  const cartId = uuidv4();

  logger.info('Adding offer to cart', {
    cartId,
    offerId: cartData.offerId,
    sellerId: cartData.sellerId,
    quantity: cartData.quantity,
    service: 'cart-api',
    route: '/api/oncall/marketplace/cart',
  });

  try {
    const offer = lookupOffer(cartData.offerId);
    if (!offer) {
      const err = new Error(`Unknown offer: ${cartData.offerId}`);
      err.code = 'OFFER_NOT_FOUND';
      throw err;
    }

    const quantity = Math.min(Math.max(parseInt(cartData.quantity, 10) || 1, 1), 5);
    const reservation = await withDeadline(
      reserveStock(offer, quantity, cartId),
      RESERVATION_DEADLINE_MS,
      'Stock reservation',
    );

    const duration = Date.now() - startTime;
    const subtotalCents = offer.priceCents * quantity;

    incrementMetric('cart.add.success', {
      route: '/api/oncall/marketplace/cart',
      sellerId: offer.sellerId,
    });
    recordTiming('cart.add.latency', duration, {
      route: '/api/oncall/marketplace/cart',
    });

    return {
      success: true,
      cartId,
      offerId: offer.id,
      quantity,
      subtotal: subtotalCents / 100,
      subtotalFormatted: formatEuro(subtotalCents),
      reservationRef: reservation.reservationRef,
      addedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('cart.add.failure', {
      route: '/api/oncall/marketplace/cart',
      errorClass: error.name,
    });
    recordTiming('cart.add.latency', duration, {
      route: '/api/oncall/marketplace/cart',
      error: 'true',
    });

    logger.error('Add to cart failed', {
      cartId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      offerId: cartData.offerId,
      sellerId: cartData.sellerId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/oncall/marketplace/cart',
        service: 'cart-api',
        sellerId: cartData.sellerId,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { cartId, offerId: cartData.offerId, quantity: cartData.quantity },
    });

    throw error;
  }
}

module.exports = { addToCart, OFFERS, FULFILMENT_NODES, RESERVATION_DEADLINE_MS };
