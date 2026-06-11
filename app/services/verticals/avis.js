const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Avis vehicle fleet — rental car classes priced per day
 */
const CATALOG = [
  { id: 'AVIS-ECON', name: 'Economy', price: 42.00, category: 'economy', example: 'Kia Rio or similar' },
  { id: 'AVIS-COMP', name: 'Compact', price: 48.00, category: 'economy', example: 'Nissan Versa or similar' },
  { id: 'AVIS-MID', name: 'Intermediate', price: 55.00, category: 'standard', example: 'Toyota Corolla or similar' },
  { id: 'AVIS-FULL', name: 'Full-Size', price: 64.00, category: 'standard', example: 'Chevrolet Malibu or similar' },
  { id: 'AVIS-SUV', name: 'Standard SUV', price: 89.00, category: 'suv', example: 'Ford Escape or similar' },
  { id: 'AVIS-MINI', name: 'Minivan', price: 102.00, category: 'van', example: 'Chrysler Pacifica or similar' },
  { id: 'AVIS-LUX', name: 'Luxury', price: 145.00, category: 'premium', example: 'Cadillac CT5 or similar' },
  { id: 'AVIS-CONV', name: 'Convertible', price: 168.00, category: 'premium', example: 'Ford Mustang Convertible or similar' },
];

/**
 * Rental location configuration — taxes/fees rate + billing currency per market
 */
const RENTAL_LOCATIONS = {
  LAX: { feeRate: 0.22, currency: 'USD' },
  JFK: { feeRate: 0.26, currency: 'USD' },
  ORD: { feeRate: 0.21, currency: 'USD' },
  MIA: { feeRate: 0.24, currency: 'USD' },
};

/**
 * Active loyalty perks — "Avis Preferred" reward credit.
 * Applied server-side so it appears on the reservation summary.
 */
const ACTIVE_ADDONS = [
  { sku: 'PROMO-PREFERRED-2026', name: 'Avis Preferred Reward Credit', price: 0, qty: 1 },
];

/**
 * Looks up the loyalty tier discount for a given rental subtotal.
 */
function getLoyaltyDiscount(subtotal) {
  if (subtotal >= 1000) return { rate: 0.15, label: '15% off Presidents Club rentals $1k+' };
  if (subtotal >= 500) return { rate: 0.10, label: '10% off Preferred Plus rentals $500+' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges loyalty add-ons into the reservation line items.
 */
function applyAddons(items) {
  return [...items, ...ACTIVE_ADDONS];
}

/**
 * Computes the final reservation charges.
 */
function computeReservationCharges(subtotal, location) {
  const locationConfig = RENTAL_LOCATIONS[location];
  if (!locationConfig) {
    throw Object.assign(new Error(`Unknown rental location: ${location}`), { code: 'INVALID_LOCATION' });
  }
  const taxesAndFees = subtotal * locationConfig.feeRate;
  const discount = getLoyaltyDiscount(subtotal);
  const discountAmount = (subtotal + taxesAndFees) * discount.rate;
  return {
    subtotal,
    taxesAndFees: Math.round(taxesAndFees * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    discountLabel: discount.label,
    total: Math.round((subtotal + taxesAndFees - discountAmount) * 100) / 100,
    currency: locationConfig.currency,
  };
}

/**
 * Formats the reservation summary for the confirmation.
 * BUG: PROMO-PREFERRED-2026 is not in CATALOG, so vehicle.name crashes.
 */
function formatReservation(allItems) {
  return allItems.map((item) => {
    const vehicle = CATALOG.find((v) => v.id === item.sku);
    return {
      sku: item.sku,
      name: vehicle.name,
      category: vehicle.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes an Avis car rental reservation.
 */
async function processReservation(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Avis reservation', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'avis-rental',
    route: '/api/avis/reservation',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyAddons(orderData.items);

    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeReservationCharges(finalSubtotal, orderData.location);
    const summary = formatReservation(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/avis/reservation',
      source: 'avis-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/avis/reservation',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      taxesAndFees: result.taxesAndFees,
      discount: result.discount,
      discountLabel: result.discountLabel,
      summary,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/avis/reservation',
      errorClass: error.name,
      source: 'avis-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/avis/reservation',
      error: 'true',
    });

    logger.error('Avis reservation failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'avis-rental',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/avis/reservation',
        service: 'avis-rental',
        source: 'avis-portal',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        location: orderData.location,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/avis.js \u2014 formatReservation',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'avis-rental',
      verticalLabel: 'Avis Reservation',
      tags: [
        { key: 'route', value: '/api/avis/reservation' },
        { key: 'service', value: 'avis-rental' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'avis-rental@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Avis reservation error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processReservation, computeReservationCharges, formatReservation, applyAddons, CATALOG, RENTAL_LOCATIONS };
