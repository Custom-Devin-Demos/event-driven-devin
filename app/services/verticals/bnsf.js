const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * BNSF freight equipment catalog — rail shipping services priced per car/container
 */
const CATALOG = [
  { id: 'BNSF-INT-53HC', name: "53' Domestic Intermodal Container", price: 2850.00, category: 'intermodal', commodity: 'Consumer Products' },
  { id: 'BNSF-INT-40HC', name: "40' International Container", price: 3200.00, category: 'intermodal', commodity: 'Import/Export' },
  { id: 'BNSF-BOX-60', name: "60' Boxcar", price: 4100.00, category: 'industrial', commodity: 'Paper & Lumber' },
  { id: 'BNSF-CVH-CG', name: 'Covered Hopper', price: 3750.00, category: 'agricultural', commodity: 'Grain' },
  { id: 'BNSF-CBT-LBR', name: 'Centerbeam Flatcar', price: 3950.00, category: 'industrial', commodity: 'Building Products' },
  { id: 'BNSF-TANK-CH', name: 'Tank Car', price: 5400.00, category: 'industrial', commodity: 'Chemicals' },
  { id: 'BNSF-AUTO-MX', name: 'Multilevel Auto Rack', price: 6200.00, category: 'automotive', commodity: 'Finished Vehicles' },
  { id: 'BNSF-COAL-OT', name: 'Open-Top Hopper', price: 2400.00, category: 'energy', commodity: 'Coal' },
];

/**
 * Shipping lane configuration — fuel surcharge rate + billing currency per corridor
 */
const FREIGHT_LANES = {
  TRANSCON: { fuelRate: 0.18, currency: 'USD' },
  MIDWEST: { fuelRate: 0.14, currency: 'USD' },
  PNW: { fuelRate: 0.16, currency: 'USD' },
  GULF: { fuelRate: 0.15, currency: 'USD' },
};

/**
 * Active accessorial credits — "Q2 Fuel Program" rebate.
 * Applied server-side so it appears on the booking manifest.
 */
const ACTIVE_ACCESSORIALS = [
  { sku: 'ACC-FUELCREDIT-2026', name: 'Q2 Fuel Surcharge Credit', price: 0, qty: 1 },
];

/**
 * Looks up the volume contract discount for a given linehaul subtotal.
 */
function getVolumeDiscount(subtotal) {
  if (subtotal >= 20000) return { rate: 0.12, label: '12% off contracts $20k+' };
  if (subtotal >= 10000) return { rate: 0.08, label: '8% off contracts $10k+' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges accessorial credits into the shipment line items.
 */
function applyAccessorials(items) {
  return [...items, ...ACTIVE_ACCESSORIALS];
}

/**
 * Computes the final shipment charges.
 */
function computeShipmentCharges(subtotal, lane) {
  const laneConfig = FREIGHT_LANES[lane];
  if (!laneConfig) {
    throw Object.assign(new Error(`Unknown freight lane: ${lane}`), { code: 'INVALID_LANE' });
  }
  const fuelSurcharge = subtotal * laneConfig.fuelRate;
  const discount = getVolumeDiscount(subtotal);
  const discountAmount = (subtotal + fuelSurcharge) * discount.rate;
  return {
    subtotal,
    fuelSurcharge: Math.round(fuelSurcharge * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    discountLabel: discount.label,
    total: Math.round((subtotal + fuelSurcharge - discountAmount) * 100) / 100,
    currency: laneConfig.currency,
  };
}

/**
 * Formats the booking manifest for the confirmation.
 * BUG: ACC-FUELCREDIT-2026 is not in CATALOG, so equipment.name crashes.
 */
function formatManifest(allItems) {
  return allItems.map((item) => {
    const equipment = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: equipment.name,
      category: equipment.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes a BNSF freight shipment booking.
 */
async function processBooking(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing BNSF freight booking', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'bnsf-freight',
    route: '/api/bnsf/booking',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyAccessorials(orderData.items);

    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeShipmentCharges(finalSubtotal, orderData.lane);
    const manifest = formatManifest(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/bnsf/booking',
      source: 'bnsf-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/bnsf/booking',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      fuelSurcharge: result.fuelSurcharge,
      discount: result.discount,
      discountLabel: result.discountLabel,
      manifest,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/bnsf/booking',
      errorClass: error.name,
      source: 'bnsf-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/bnsf/booking',
      error: 'true',
    });

    logger.error('BNSF freight booking failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'bnsf-freight',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/bnsf/booking',
        service: 'bnsf-freight',
        source: 'bnsf-portal',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        lane: orderData.lane,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/bnsf.js \u2014 formatManifest',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'bnsf-freight',
      verticalLabel: 'BNSF Freight Booking',
      tags: [
        { key: 'route', value: '/api/bnsf/booking' },
        { key: 'service', value: 'bnsf-freight' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'bnsf-freight@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from BNSF booking error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processBooking, computeShipmentCharges, formatManifest, applyAccessorials, CATALOG, FREIGHT_LANES };
