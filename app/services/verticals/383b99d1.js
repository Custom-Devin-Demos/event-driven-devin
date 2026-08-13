const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const STYLE_AFFINITY_VIEW = require('./features/383b99d1-style-affinity.json');

/**
 * Gap online storefront catalog.
 */
const CATALOG = [
  { id: 'GAP-DNM-9001', name: "Gap '90s Original Straight Jeans", price: 79.95, style: 'denim', unit: 'Dark Indigo' },
  { id: 'GAP-TEE-0410', name: 'Gap Vintage Soft Crewneck Tee', price: 24.95, style: 'tees', unit: 'Optic White' },
  { id: 'GAP-OTR-2205', name: 'Gap Icon Denim Jacket', price: 98.00, style: 'outerwear', unit: 'Medium Wash' },
  { id: 'GAP-ACT-5108', name: 'GapFit Brushed Tech Jersey Hoodie', price: 64.95, style: 'activewear', unit: 'True Black' },
  { id: 'GAP-KID-3302', name: 'babyGap Organic Cotton Bodysuit 3-Pack', price: 34.95, style: 'kids', unit: '0-3 M' },
  { id: 'GAP-ACC-7710', name: 'Gap Logo Canvas Tote', price: 39.95, style: 'accessories', unit: 'Natural' },
];

/**
 * Shipping methods available at checkout.
 * Only methods marked `feeWaivable` are covered by the Good Rewards free-shipping benefit.
 */
const SHIPPING_METHODS = {
  standard: { baseFee: 7.00, slaDays: 5, label: 'Standard Shipping', feeWaivable: true },
  express: { baseFee: 17.00, slaDays: 2, label: 'Express Shipping', feeWaivable: false },
  pickup: { baseFee: 0.00, slaDays: 1, label: 'Free Store Pickup', feeWaivable: false },
};

/**
 * Sales tax by ship-to state.
 */
const TAX_RATES = {
  CA: 0.0725,
  NY: 0.0400,
  TX: 0.0625,
  OH: 0.0575,
  FL: 0.0600,
};

/**
 * Gap Good Rewards membership tiers.
 * `icon` was introduced with the Good Rewards relaunch.
 */
const MEMBERSHIP_TIERS = {
  core: { label: 'Good Rewards Core', freeShipping: 0 },
  enrolled: { label: 'Good Rewards Enrolled', freeShipping: 1 },
  icon: { label: 'Good Rewards Icon', freeShipping: 1 },
};

/**
 * Good Rewards points earn rates keyed by internal program code.
 */
const REWARDS_POINT_PROGRAMS = {
  gr_core: { pointsPerDollar: 1, label: '1 point per $1' },
  gr_enrolled: { pointsPerDollar: 2, label: '2 points per $1' },
};

/**
 * Maps a shopper's membership tier onto its internal Good Rewards program code.
 */
const MEMBERSHIP_PROGRAM_CODES = {
  core: 'gr_core',
  enrolled: 'gr_enrolled',
  icon: 'gr_icon',
};

/**
 * Resolves a membership tier to its internal program code, ignoring
 * anything inherited from Object.prototype.
 */
function resolveProgramCode(membership) {
  return Object.prototype.hasOwnProperty.call(MEMBERSHIP_PROGRAM_CODES, membership)
    ? MEMBERSHIP_PROGRAM_CODES[membership]
    : 'gr_core';
}

/**
 * Resolves the Good Rewards points program for a membership tier.
 */
function resolveRewardsProgram(membership) {
  return REWARDS_POINT_PROGRAMS[resolveProgramCode(membership)];
}

/**
 * Computes Good Rewards points earned on an order.
 */
function computeRewardsPoints(subtotal, membership) {
  const program = resolveRewardsProgram(membership);
  return {
    points: Math.floor(subtotal) * program.pointsPerDollar,
    programLabel: program.label,
  };
}

/**
 * Personalized offer pool served on the storefront.
 */
const OFFER_POOL = [
  { id: 'OFR-DNM-30', title: '30% off all denim', style: 'denim', detail: 'Through Sunday' },
  { id: 'OFR-TEE-B2G1', title: 'Buy 2 get 1 free tees', style: 'tees', detail: 'Online only' },
  { id: 'OFR-OTR-25', title: '25% off outerwear', style: 'outerwear', detail: 'This week only' },
  { id: 'OFR-ACT-20', title: '20% off GapFit activewear', style: 'activewear', detail: 'Members only' },
  { id: 'OFR-KID-40', title: '40% off babyGap & GapKids', style: 'kids', detail: 'Ends Friday' },
  { id: 'OFR-ACC-15', title: '15% off bags & accessories', style: 'accessories', detail: 'Limit 2' },
];

/**
 * Resolves the affinity weights for a shopper's segment against the materialized
 * style-affinity feature view built from pipelines/gap/style-affinity-spec.json.
 *
 * Segments the feature view does not encode score against an empty weight set.
 */
function resolveStyleSegment(membership) {
  const code = resolveProgramCode(membership);
  const segments = STYLE_AFFINITY_VIEW.segments || {};
  const entry = Object.prototype.hasOwnProperty.call(segments, code) ? segments[code] : null;
  // "Absent from the feature view" and "present but contributing nothing" serve
  // identically, so the caller needs them distinguished to report which one happened.
  // A non-object entry (only reachable by hand-editing the artifact past the build)
  // counts as absent rather than throwing, so degradation stays silent either way.
  // Arrays are objects but carry no style keys, so they are absent too.
  const encoded = Boolean(entry) && typeof entry === 'object' && !Array.isArray(entry);
  return { code, encoded, weights: encoded ? entry : {} };
}

/**
 * Ranks the offer pool for a shopper and returns the top slots.
 *
 * Offers that score above zero are personalized; the storefront always has the
 * same number of slots to fill, so anything the segment does not score for is
 * backfilled behind the ranked offers rather than leaving the grid short.
 */
function rankOffers(membership, limit = 3) {
  const segment = resolveStyleSegment(membership);

  const graded = OFFER_POOL.map((offer) => ({ ...offer, score: segment.weights[offer.style] || 0 }));
  const scored = graded.filter((offer) => offer.score > 0).sort((a, b) => b.score - a.score);

  const personalized = scored.length > 0;
  // A segment with weights for only some styles is still personalized, but it ranks
  // fewer offers than the grid shows. Backfill keeps slot count a property of the
  // storefront rather than of how completely the feature view happens to cover the
  // vocabulary — otherwise partial coverage degrades as a short grid, which is a
  // third failure mode nobody is looking for.
  const offers = scored.concat(graded.filter((offer) => offer.score === 0)).slice(0, limit);
  const matchRate = OFFER_POOL.length ? scored.length / OFFER_POOL.length : 0;

  recordMetric('personalization.offer_match_rate', matchRate, {
    route: '/api/383b99d1/offers',
    segment: segment.code,
  });
  if (!personalized) {
    incrementMetric('personalization.fallback_served', {
      route: '/api/383b99d1/offers',
      segment: segment.code,
    });
  }

  logger.info('Ranked Gap storefront offers', {
    membership,
    segment: segment.code,
    featureView: STYLE_AFFINITY_VIEW.featureView,
    specVersion: STYLE_AFFINITY_VIEW.specVersion,
    personalized,
    matchRate,
    service: 'gap-ecommerce',
    route: '/api/383b99d1/offers',
  });

  return {
    offers,
    personalized,
    matchRate: Math.round(matchRate * 100) / 100,
    segment: segment.code,
    segmentEncoded: segment.encoded,
    featureView: STYLE_AFFINITY_VIEW.featureView,
    specVersion: STYLE_AFFINITY_VIEW.specVersion,
  };
}

/**
 * Looks up the Good Rewards membership benefits for a shopper.
 */
function getMembershipBenefits(membership) {
  return MEMBERSHIP_TIERS[membership] || MEMBERSHIP_TIERS.core;
}

/**
 * Resolves the shipping method for a storefront selection.
 */
function resolveShippingMethod(method) {
  const plan = SHIPPING_METHODS[method];
  if (!plan) {
    throw Object.assign(new Error(`Shipping method not available: ${method}`), { code: 'SHIPPING_UNAVAILABLE' });
  }
  return plan;
}

/**
 * Computes the order total including tax, shipping fees and Good Rewards points.
 */
function computeOrderTotal(subtotal, state, method, membership) {
  const taxRate = TAX_RATES[state];
  if (taxRate === undefined) {
    throw Object.assign(new Error(`Unsupported ship-to state: ${state}`), { code: 'INVALID_STATE' });
  }

  const plan = resolveShippingMethod(method);
  const benefits = getMembershipBenefits(membership);
  const waiver = plan.feeWaivable ? benefits.freeShipping : 0;
  const shippingFee = plan.baseFee * (1 - waiver);
  const tax = subtotal * taxRate;
  const rewards = computeRewardsPoints(subtotal, membership);

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    shippingFee: Math.round(shippingFee * 100) / 100,
    shippingLabel: plan.label,
    etaDays: plan.slaDays,
    rewardsPoints: rewards.points,
    rewardsProgramLabel: rewards.programLabel,
    membershipLabel: benefits.label,
    total: Math.round((subtotal + tax + shippingFee) * 100) / 100,
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
  '`MEMBERSHIP_PROGRAM_CODES` in `app/services/verticals/383b99d1.js` has more than one consumer. `computeRewardsPoints()` dereferences the resolved program and throws — that is the alert you are looking at. `rankOffers()` resolves the same code against the materialized style-affinity feature view, finds no vector for it, scores every offer at zero and serves the unranked pool. No exception, no alert: the only signal is `personalization.offer_match_rate` dropping to 0 for that segment on `GET /api/383b99d1/offers`.',
  '',
  'The serving code is not where this originates. `pipelines/gap/style-affinity-spec.json` is the source of truth for segment encoding, and `pipelines/gap/build-style-features.js` materializes it into `app/services/verticals/features/383b99d1-style-affinity.json`. A tier declared in `membershipTiers` with no matching entry under `segments` builds clean and ships a feature view that silently cannot personalize that cohort.',
  '',
  'Run `npm run audit:gap` first — it scores every tier through the real ranker and will show you the gap and its blast radius before you change anything.',
  '',
  'Then fix it as a data problem, not a serving problem:',
  '1. Register the missing segment in the affinity spec and rebuild the feature view (do not hand-edit the built artifact).',
  '2. Make the build fail on this class of defect — a tier that encodes to a segment the spec does not carry should break `build-style-features.js`, not reach production.',
  '3. Fix the Good Rewards points crash at the same root cause.',
  '4. Add regression coverage for the silent path as well as the throwing one, and wire the audit in as a check.',
  '',
  'Call out in your PR how long the personalization regression could have run undetected, and how many shoppers were in the affected cohort.',
].join('\n');

/**
 * Places a Gap online order.
 */
async function placeOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Placing Gap order', {
    orderId,
    customerId: orderData.customerId,
    shippingMethod: orderData.shippingMethod,
    service: 'gap-ecommerce',
    route: '/api/383b99d1/order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const items = orderData.items || [];
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0) || orderData.subtotal;

    const totals = computeOrderTotal(
      subtotal,
      orderData.state,
      orderData.shippingMethod,
      orderData.membership,
    );
    const summary = buildOrderSummary(items);

    const duration = Date.now() - startTime;

    incrementMetric('order.success', {
      route: '/api/383b99d1/order',
      source: 'gap-storefront',
    });
    recordTiming('order.latency', duration, {
      route: '/api/383b99d1/order',
    });

    return {
      success: true,
      orderId,
      ...totals,
      items: summary,
      status: 'placed',
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.failure', {
      route: '/api/383b99d1/order',
      errorClass: error.name,
      source: 'gap-storefront',
    });
    recordTiming('order.latency', duration, {
      route: '/api/383b99d1/order',
      error: 'true',
    });

    logger.error('Gap order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      customerId: orderData.customerId,
      membership: orderData.membership,
      shippingMethod: orderData.shippingMethod,
      service: 'gap-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/383b99d1/order',
        service: 'gap-ecommerce',
        source: 'gap-storefront',
      },
      extra: {
        orderId,
        customerId: orderData.customerId,
        membership: orderData.membership,
        shippingMethod: orderData.shippingMethod,
        state: orderData.state,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/383b99d1.js \u2014 computeRewardsPoints',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '383b99d1',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'gap-ecommerce',
      verticalLabel: 'Gap Online Checkout',
      promptAppendix: SECOND_ORDER_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/383b99d1/order' },
        { key: 'service', value: 'gap-ecommerce' },
        { key: 'membership', value: String(orderData.membership) },
        { key: 'shipping_method', value: String(orderData.shippingMethod) },
      ],
      extra: {
        orderId,
        customerId: orderData.customerId,
        membership: orderData.membership,
        shippingMethod: orderData.shippingMethod,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'gap-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Gap order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  computeOrderTotal,
  computeRewardsPoints,
  resolveRewardsProgram,
  resolveShippingMethod,
  getMembershipBenefits,
  buildOrderSummary,
  rankOffers,
  resolveStyleSegment,
  SECOND_ORDER_DIRECTIVE,
  CATALOG,
  SHIPPING_METHODS,
  REWARDS_POINT_PROGRAMS,
  MEMBERSHIP_PROGRAM_CODES,
  MEMBERSHIP_TIERS,
  OFFER_POOL,
  STYLE_AFFINITY_VIEW,
  TAX_RATES,
};
