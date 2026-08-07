const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const OFFER_AFFINITY_VIEW = require('./features/eaa595e1-offer-affinity.json');

/**
 * Kroger online grocery catalog.
 */
const CATALOG = [
  { id: 'KRO-ST-MILK', name: 'Simple Truth Organic Whole Milk, 1 Gallon', price: 5.49, category: 'dairy', unit: '128 fl oz' },
  { id: 'KRO-PS-COF', name: 'Private Selection Sumatra Ground Coffee', price: 8.99, category: 'grocery', unit: '12 oz' },
  { id: 'KRO-BAN-ORG', name: 'Simple Truth Organic Bananas', price: 1.79, category: 'produce', unit: 'per bunch' },
  { id: 'KRO-BAK-SRD', name: 'Kroger Bakery Sourdough Boule', price: 4.29, category: 'bakery', unit: 'each' },
  { id: 'KRO-MEAT-CHK', name: 'Simple Truth Boneless Chicken Breast', price: 12.47, category: 'meat', unit: 'per lb' },
  { id: 'KRO-HB-EGG', name: 'Kroger Grade A Large Eggs, 18 ct', price: 4.19, category: 'dairy', unit: '18 ct' },
  { id: 'KRO-HH-PTW', name: 'Kroger Paper Towels, 6 Big Rolls', price: 9.99, category: 'household', unit: '6 ct' },
  { id: 'KRO-DEL-CHZ', name: 'Murray\u2019s Aged Cheddar, Deli Cut', price: 7.99, category: 'deli', unit: 'per lb' },
];

/**
 * Store fulfillment plans keyed by fulfillment method.
 * Each plan carries the base fee charged before Boost benefits are applied.
 * Only plans marked `feeWaivable` are covered by the Boost delivery benefit.
 */
const FULFILLMENT_PLANS = {
  pickup: { baseFee: 0.00, slaMinutes: 240, label: 'Store Pickup', feeWaivable: false },
  delivery: { baseFee: 9.95, slaMinutes: 180, label: 'Scheduled Delivery', feeWaivable: true },
  ship: { baseFee: 4.99, slaMinutes: 2880, label: 'Kroger Ship', feeWaivable: false },
};

/**
 * Sales tax by ship-to state.
 */
const TAX_RATES = {
  OH: 0.0575,
  KY: 0.0600,
  TX: 0.0825,
  MI: 0.0600,
  GA: 0.0400,
};

/**
 * Kroger Boost membership benefits.
 * `boost-annual` was introduced with the annual-billing rollout.
 */
const MEMBERSHIP_TIERS = {
  none: { label: 'No membership', deliveryFeeWaiver: 0 },
  'boost-monthly': { label: 'Boost (monthly)', deliveryFeeWaiver: 1 },
  'boost-annual': { label: 'Boost (annual)', deliveryFeeWaiver: 1 },
};

/**
 * Fuel Points earn rates keyed by internal program code.
 */
const FUEL_POINT_PROGRAMS = {
  standard: { pointsPerDollar: 1, label: '1 Fuel Point per $1' },
  boost_monthly: { pointsPerDollar: 2, label: '2x Fuel Points per $1' },
};

/**
 * Maps a shopper's membership tier onto its internal Fuel Points program code.
 */
const MEMBERSHIP_FUEL_PROGRAM_CODES = {
  none: 'standard',
  'boost-monthly': 'boost_monthly',
  'boost-annual': 'boost_annual',
};

/**
 * Resolves a membership tier to its internal program code, ignoring
 * anything inherited from Object.prototype.
 */
function resolveProgramCode(membership) {
  return Object.prototype.hasOwnProperty.call(MEMBERSHIP_FUEL_PROGRAM_CODES, membership)
    ? MEMBERSHIP_FUEL_PROGRAM_CODES[membership]
    : 'standard';
}

/**
 * Resolves the Fuel Points program for a membership tier.
 */
function resolveFuelProgram(membership) {
  return FUEL_POINT_PROGRAMS[resolveProgramCode(membership)];
}

/**
 * Computes Fuel Points earned on an order.
 */
function computeFuelPoints(subtotal, membership) {
  const program = resolveFuelProgram(membership);
  return {
    points: Math.floor(subtotal) * program.pointsPerDollar,
    programLabel: program.label,
  };
}

/**
 * Personalized offer pool served on the storefront.
 */
const OFFER_POOL = [
  { id: 'OFR-DAIRY-15', title: '15% off Simple Truth dairy', category: 'dairy', detail: 'Through Sunday' },
  { id: 'OFR-PROD-2X', title: '2x Fuel Points on fresh produce', category: 'produce', detail: 'This week only' },
  { id: 'OFR-COF-300', title: '$3 off Private Selection coffee', category: 'grocery', detail: 'Limit 2' },
  { id: 'OFR-MEAT-BOGO', title: 'BOGO Simple Truth chicken breast', category: 'meat', detail: 'Store #01400' },
  { id: 'OFR-BAKE-150', title: '$1.50 off bakery breads', category: 'bakery', detail: 'Baked fresh daily' },
  { id: 'OFR-HH-20', title: '20% off household paper goods', category: 'household', detail: 'Through Sunday' },
];

/**
 * Resolves the affinity weights for a shopper's segment against the materialized
 * offer-affinity feature view built from pipelines/kroger/offer-affinity-spec.json.
 *
 * Segments the feature view does not encode score against an empty weight set.
 */
function resolveOfferSegment(membership) {
  const code = resolveProgramCode(membership);
  const segments = OFFER_AFFINITY_VIEW.segments || {};
  const entry = Object.prototype.hasOwnProperty.call(segments, code) ? segments[code] : null;
  // "Absent from the feature view" and "present but contributing nothing" serve
  // identically, so the caller needs them distinguished to report which one happened.
  // A non-object entry (only reachable by hand-editing the artifact past the build)
  // counts as absent rather than throwing, so degradation stays silent either way.
  const encoded = Boolean(entry) && typeof entry === 'object';
  return { code, encoded, weights: encoded ? entry : {} };
}

/**
 * Ranks the offer pool for a shopper and returns the top slots.
 *
 * Offers that score above zero are personalized; when nothing scores, the
 * storefront still has slots to fill, so it falls back to the unranked pool.
 */
function rankOffers(membership, limit = 3) {
  const segment = resolveOfferSegment(membership);

  const scored = OFFER_POOL
    .map((offer) => ({ ...offer, score: segment.weights[offer.category] || 0 }))
    .filter((offer) => offer.score > 0)
    .sort((a, b) => b.score - a.score);

  const personalized = scored.length > 0;
  const offers = (personalized ? scored : OFFER_POOL.map((o) => ({ ...o, score: 0 }))).slice(0, limit);
  const matchRate = OFFER_POOL.length ? scored.length / OFFER_POOL.length : 0;

  recordMetric('personalization.offer_match_rate', matchRate, {
    route: '/api/eaa595e1/offers',
    segment: segment.code,
  });
  if (!personalized) {
    incrementMetric('personalization.fallback_served', {
      route: '/api/eaa595e1/offers',
      segment: segment.code,
    });
  }

  logger.info('Ranked Kroger storefront offers', {
    membership,
    segment: segment.code,
    featureView: OFFER_AFFINITY_VIEW.featureView,
    specVersion: OFFER_AFFINITY_VIEW.specVersion,
    personalized,
    matchRate,
    service: 'kroger-ecommerce',
    route: '/api/eaa595e1/offers',
  });

  return {
    offers,
    personalized,
    matchRate: Math.round(matchRate * 100) / 100,
    segment: segment.code,
    segmentEncoded: segment.encoded,
    featureView: OFFER_AFFINITY_VIEW.featureView,
    specVersion: OFFER_AFFINITY_VIEW.specVersion,
  };
}

/**
 * Looks up the Boost membership benefits for a shopper.
 */
function getMembershipBenefits(membership) {
  return MEMBERSHIP_TIERS[membership] || MEMBERSHIP_TIERS.none;
}

/**
 * Resolves the fulfillment plan for a storefront selection.
 */
function resolveFulfillmentPlan(method) {
  const plan = FULFILLMENT_PLANS[method];
  if (!plan) {
    throw Object.assign(new Error(`Fulfillment method not available: ${method}`), { code: 'FULFILLMENT_UNAVAILABLE' });
  }
  return plan;
}

/**
 * Computes the order total including tax, fulfillment fees and Fuel Points.
 */
function computeOrderTotal(subtotal, state, method, membership) {
  const taxRate = TAX_RATES[state];
  if (taxRate === undefined) {
    throw Object.assign(new Error(`Unsupported ship-to state: ${state}`), { code: 'INVALID_STATE' });
  }

  const plan = resolveFulfillmentPlan(method);
  const benefits = getMembershipBenefits(membership);
  const waiver = plan.feeWaivable ? benefits.deliveryFeeWaiver : 0;
  const fulfillmentFee = plan.baseFee * (1 - waiver);
  const tax = subtotal * taxRate;
  const fuel = computeFuelPoints(subtotal, membership);

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    fulfillmentFee: Math.round(fulfillmentFee * 100) / 100,
    fulfillmentLabel: plan.label,
    etaMinutes: plan.slaMinutes,
    fuelPoints: fuel.points,
    fuelProgramLabel: fuel.programLabel,
    membershipLabel: benefits.label,
    total: Math.round((subtotal + tax + fulfillmentFee) * 100) / 100,
  };
}

/**
 * Builds the itemized order summary shown on the confirmation page.
 */
function buildOrderSummary(items) {
  return items.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku) || {};
    return {
      sku: item.sku,
      name: product.name || item.sku,
      unit: product.unit || '',
      qty: item.qty,
      lineTotal: Math.round(item.price * item.qty * 100) / 100,
    };
  });
}

/**
 * The checkout crash is the loud half of this defect. The same membership
 * mapping feeds offer ranking, where a segment the feature view never encoded
 * degrades silently instead of throwing, so the triage session is told to fix
 * the pipeline that produced the gap rather than the serving code that hit it.
 */
const SECOND_ORDER_DIRECTIVE = [
  '*Check the blast radius before you fix the crash.*',
  '',
  '`MEMBERSHIP_FUEL_PROGRAM_CODES` in `app/services/verticals/eaa595e1.js` has more than one consumer. `computeFuelPoints()` dereferences the resolved program and throws — that is the alert you are looking at. `rankOffers()` resolves the same code against the materialized offer-affinity feature view, finds no vector for it, scores every offer at zero and serves the unranked pool. No exception, no alert: the only signal is `personalization.offer_match_rate` dropping to 0 for that segment on `GET /api/eaa595e1/offers`.',
  '',
  'The serving code is not where this originates. `pipelines/kroger/offer-affinity-spec.json` is the source of truth for segment encoding, and `pipelines/kroger/build-offer-features.js` materializes it into `app/services/verticals/features/eaa595e1-offer-affinity.json`. A tier declared in `membershipTiers` with no matching entry under `segments` builds clean and ships a feature view that silently cannot personalize that cohort.',
  '',
  'Run `npm run audit:kroger` first — it scores every tier through the real ranker and will show you the gap and its blast radius before you change anything.',
  '',
  'Then fix it as a data problem, not a serving problem:',
  '1. Register the missing segment in the affinity spec and rebuild the feature view (do not hand-edit the built artifact).',
  '2. Make the build fail on this class of defect — a tier that encodes to a segment the spec does not carry should break `build-offer-features.js`, not reach production.',
  '3. Fix the Fuel Points crash at the same root cause.',
  '4. Add regression coverage for the silent path as well as the throwing one, and wire the audit in as a check.',
  '',
  'Call out in your PR how long the personalization regression could have run undetected, and how many shoppers were in the affected cohort.',
].join('\n');

/**
 * Places a Kroger online grocery order.
 */
async function placeOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Placing Kroger order', {
    orderId,
    customerId: orderData.customerId,
    fulfillmentMethod: orderData.fulfillmentMethod,
    storeId: orderData.storeId,
    service: 'kroger-ecommerce',
    route: '/api/eaa595e1/order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const items = orderData.items || [];
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0) || orderData.subtotal;

    const totals = computeOrderTotal(
      subtotal,
      orderData.state,
      orderData.fulfillmentMethod,
      orderData.membership,
    );
    const summary = buildOrderSummary(items);

    const duration = Date.now() - startTime;

    incrementMetric('order.success', {
      route: '/api/eaa595e1/order',
      source: 'kroger-storefront',
    });
    recordTiming('order.latency', duration, {
      route: '/api/eaa595e1/order',
    });

    return {
      success: true,
      orderId,
      storeId: orderData.storeId,
      ...totals,
      items: summary,
      status: 'placed',
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.failure', {
      route: '/api/eaa595e1/order',
      errorClass: error.name,
      source: 'kroger-storefront',
    });
    recordTiming('order.latency', duration, {
      route: '/api/eaa595e1/order',
      error: 'true',
    });

    logger.error('Kroger order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      customerId: orderData.customerId,
      membership: orderData.membership,
      fulfillmentMethod: orderData.fulfillmentMethod,
      service: 'kroger-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/eaa595e1/order',
        service: 'kroger-ecommerce',
        source: 'kroger-storefront',
      },
      extra: {
        orderId,
        customerId: orderData.customerId,
        storeId: orderData.storeId,
        membership: orderData.membership,
        fulfillmentMethod: orderData.fulfillmentMethod,
        state: orderData.state,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/eaa595e1.js \u2014 computeFuelPoints',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'eaa595e1',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'kroger-ecommerce',
      verticalLabel: 'Kroger Grocery Checkout',
      promptAppendix: SECOND_ORDER_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/eaa595e1/order' },
        { key: 'service', value: 'kroger-ecommerce' },
        { key: 'membership', value: String(orderData.membership) },
        { key: 'fulfillment_method', value: String(orderData.fulfillmentMethod) },
      ],
      extra: {
        orderId,
        customerId: orderData.customerId,
        storeId: orderData.storeId,
        membership: orderData.membership,
        fulfillmentMethod: orderData.fulfillmentMethod,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'kroger-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Kroger order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  computeOrderTotal,
  computeFuelPoints,
  resolveFuelProgram,
  resolveFulfillmentPlan,
  getMembershipBenefits,
  buildOrderSummary,
  rankOffers,
  resolveOfferSegment,
  SECOND_ORDER_DIRECTIVE,
  CATALOG,
  FULFILLMENT_PLANS,
  FUEL_POINT_PROGRAMS,
  MEMBERSHIP_FUEL_PROGRAM_CODES,
  MEMBERSHIP_TIERS,
  OFFER_POOL,
  OFFER_AFFINITY_VIEW,
  TAX_RATES,
};
