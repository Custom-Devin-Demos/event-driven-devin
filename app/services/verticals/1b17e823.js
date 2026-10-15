const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/1b17e823/checkout';
const SERVICE = 'customer-1b17e823-checkout';

/**
 * Products that can be placed in the cart. `category` drives Pennsylvania
 * sales-tax treatment (clothing and footwear are exempt).
 */
const CATALOG = [
  {
    sku: '24NIKMPGSS41RDXXXRNN',
    name: "Nike Men's Pegasus 41 Running Shoes",
    brand: 'Nike',
    price: 139.99,
    category: 'footwear',
    color: 'University Red/White',
    size: '10.5',
    limitPerOrder: 4,
  },
  {
    sku: '20SPAUTF1000LGCYBSKB',
    name: 'Spalding TF-1000 Legacy Official Indoor Basketball',
    brand: 'Spalding',
    price: 69.99,
    category: 'equipment',
    color: 'Brown',
    size: '29.5"',
    limitPerOrder: 6,
  },
  {
    sku: '22UARMHTGR20SHRTBLK',
    name: "Under Armour Men's HeatGear Fitted Short Sleeve Shirt",
    brand: 'Under Armour',
    price: 30.00,
    category: 'apparel',
    color: 'Black',
    size: 'L',
    limitPerOrder: 10,
  },
];

const PA_CLOTHING_EXEMPT = ['apparel', 'footwear'];
const NYC_TAX = { jurisdiction: 'NY — New York City', rate: 0.08875, exempt: ['apparel', 'footwear'], exemptBelow: 110 };
const NYC_ZIP_PREFIXES = [100, 101, 102, 103, 104, 111, 112, 113, 114, 116];
const NYC_ZIPS = ['11004', '11005'];
const ALLEGHENY_TAX = { jurisdiction: 'PA — Allegheny County', rate: 0.07, exempt: PA_CLOTHING_EXEMPT };
const PA_STATE_TAX = { jurisdiction: 'PA — statewide', rate: 0.06, exempt: PA_CLOTHING_EXEMPT };
const DEFAULT_TAX = { jurisdiction: 'US — standard', rate: 0.06, exempt: [] };

const PAYMENT_METHODS = {
  card: 'Credit / Debit Card',
  paypal: 'PayPal',
  applepay: 'Apple Pay',
};

const SHIPPING = {
  ship: { label: 'Ship to Me', fee: 7.99, freeThreshold: 65 },
  pickup: { label: 'Free Store Pickup', fee: 0, freeThreshold: 0 },
};

/**
 * ScoreCard earn rates. Every point-earning member resolves to one of these.
 */
const SCORECARD_TIERS = {
  standard: { label: 'ScoreCard', pointsPerDollar: 1, bonusMultiplier: 1 },
  gold: { label: 'ScoreCard Gold', pointsPerDollar: 1, bonusMultiplier: 1.5 },
  platinum: { label: 'ScoreCard Platinum', pointsPerDollar: 1, bonusMultiplier: 2 },
};

/** Every 300 points issues a $10 ScoreCard reward. */
const REWARD_POINTS = 300;
const REWARD_VALUE = 10;

/**
 * Issued ScoreCard rewards, keyed by reward code. Unredeemed rewards on a
 * member's account are applied automatically at checkout.
 */
const REWARD_CERTIFICATES = {
  'SCR-0212-7741': { value: 10, issuedAt: '2026-09-02', expiresAt: '2026-12-31' },
  'SCR-1487-3308': { value: 10, issuedAt: '2026-08-19', expiresAt: '2026-11-30' },
};

const MEMBERS = {
  'SC-8841207733': {
    id: 'SC-8841207733',
    name: 'Jordan Reyes',
    scorecardTier: 'platinum',
    pointsBalance: 240,
    // Reward codes as carried over by the ScoreCard rewards ledger migration.
    availableRewards: ['SCR02127741'],
  },
  'SC-5520917046': {
    id: 'SC-5520917046',
    name: 'Casey Morgan',
    scorecardTier: 'gold',
    pointsBalance: 280,
    availableRewards: [],
  },
};

const STORES = {
  '0212': { name: 'Robinson Township', address: '6600 Robinson Centre Dr, Pittsburgh, PA 15205', zipCode: '15205' },
  '1487': { name: 'Union Square', address: '10 Union Square E, New York, NY 10003', zipCode: '10010' },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  "The failing code path is the DICK'S Sporting Goods cart checkout vertical:",
  '- Service: `app/services/verticals/1b17e823.js`',
  '- Route: `app/routes/verticals/1b17e823.js`',
  '- Page: `app/public/verticals/1b17e823.html` (served at `/dicks`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function findProduct(sku) {
  return CATALOG.find((product) => product.sku === sku) || null;
}

function findMember(memberId) {
  return Object.hasOwn(MEMBERS, memberId) ? MEMBERS[memberId] : null;
}

function buildCartLines(items) {
  return items.map((item) => {
    const product = findProduct(item.sku);
    const qty = Number(item.qty);
    return {
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      category: product.category,
      price: product.price,
      qty,
      lineTotal: roundCurrency(product.price * qty),
    };
  });
}

function computeShipping(fulfillment, subtotal) {
  const method = SHIPPING[fulfillment] || SHIPPING.ship;
  const fee = subtotal >= method.freeThreshold ? 0 : method.fee;
  return { method: fulfillment, label: method.label, fee };
}

function taxJurisdiction(zipCode) {
  const prefix = Number(String(zipCode).slice(0, 3));
  if (NYC_ZIP_PREFIXES.includes(prefix) || NYC_ZIPS.includes(String(zipCode))) return NYC_TAX;
  if (prefix === 152) return ALLEGHENY_TAX;
  return prefix >= 150 && prefix <= 196 ? PA_STATE_TAX : DEFAULT_TAX;
}

function computeTax(lines, zipCode) {
  const { jurisdiction, rate, exempt, exemptBelow = Infinity } = taxJurisdiction(zipCode);
  const taxable = lines
    .filter((line) => !(exempt.includes(line.category) && line.price < exemptBelow))
    .reduce((sum, line) => sum + line.lineTotal, 0);
  return { jurisdiction, rate, taxableAmount: roundCurrency(taxable), tax: roundCurrency(taxable * rate) };
}

/** Resolves the ScoreCard earn tier for a signed-in member (null for guests). */
function resolveScoreCardTier(member) {
  if (!member) return null;
  return member.scorecardTier;
}

/** Applies the member's unredeemed ScoreCard rewards to the order. */
function applyScoreCardRewards(member, orderTotal) {
  if (!member || !member.availableRewards.length) {
    return { codes: [], discount: 0 };
  }
  const value = member.availableRewards
    .map((code) => REWARD_CERTIFICATES[code].value)
    .reduce((sum, amount) => sum + amount, 0);
  return { codes: [...member.availableRewards], discount: roundCurrency(Math.min(value, orderTotal)) };
}

function computeScoreCardEarn(member, tierKey, eligibleSubtotal) {
  if (!member) {
    return { member: null, pointsEarned: 0, message: 'Sign in to ScoreCard to earn points on this order.' };
  }
  const tier = SCORECARD_TIERS[tierKey];
  const pointsEarned = Math.floor(eligibleSubtotal * tier.pointsPerDollar * tier.bonusMultiplier);
  const newBalance = member.pointsBalance + pointsEarned;
  const rewardsIssued = Math.floor(newBalance / REWARD_POINTS);
  return {
    member: { id: member.id, name: member.name },
    tier: tierKey,
    tierLabel: tier.label,
    pointsEarned,
    previousBalance: member.pointsBalance,
    newBalance: newBalance % REWARD_POINTS,
    rewardsIssued,
    rewardValue: rewardsIssued * REWARD_VALUE,
    pointsToNextReward: REWARD_POINTS - (newBalance % REWARD_POINTS),
  };
}

/**
 * Prices the cart, earns ScoreCard points for signed-in members, and returns
 * the order confirmation.
 */
async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = `DSG${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const member = findMember(data.memberId);
  const store = STORES[data.storeNumber] || STORES['0212'];
  let lines = [];

  try {
    lines = buildCartLines(data.items);
    const subtotal = roundCurrency(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const shipping = computeShipping(data.fulfillment, subtotal);
    const tax = computeTax(lines, data.zipCode);
    const tierKey = resolveScoreCardTier(member);
    const scorecard = computeScoreCardEarn(member, tierKey, subtotal);
    const rewards = applyScoreCardRewards(member, roundCurrency(subtotal + shipping.fee + tax.tax));
    const total = roundCurrency(subtotal + shipping.fee + tax.tax - rewards.discount);

    incrementMetric('dsg_checkout.success', { route: ROUTE, tier: tierKey || 'guest', fulfillment: shipping.method });
    recordTiming('dsg_checkout.latency', Date.now() - startTime, { route: ROUTE });
    logger.info("DICK'S cart checkout completed", { orderId, total, tier: tierKey || 'guest', service: SERVICE });

    return {
      success: true,
      orderId,
      confirmationId: uuidv4(),
      store: { number: data.storeNumber, ...store },
      lines,
      subtotal,
      shipping,
      tax,
      rewards,
      total,
      payment: { method: data.paymentMethod, label: PAYMENT_METHODS[data.paymentMethod] },
      scorecard,
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const rewardCount = member ? member.availableRewards.length : 0;

    incrementMetric('dsg_checkout.failure', { route: ROUTE, errorClass: error.name, rewardsApplied: String(rewardCount) });
    recordTiming('dsg_checkout.latency', duration, { route: ROUTE, error: 'true' });

    logger.error("DICK'S cart checkout failed", {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      memberId: data.memberId,
      rewardsApplied: rewardCount,
      lines: lines.length,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, rewardsApplied: String(rewardCount), alert_path: 'instant' },
      extra: { orderId, memberId: data.memberId, storeNumber: data.storeNumber, zipCode: data.zipCode, lines: lines.length },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/1b17e823.js \u2014 applyScoreCardRewards',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: "DICK'S Sporting Goods — Cart Checkout & ScoreCard",
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '1b17e823',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'rewards_applied', value: String(rewardCount) },
        { key: 'store', value: data.storeNumber },
      ],
      extra: {
        orderId,
        memberId: data.memberId,
        storeNumber: data.storeNumber,
        zipCode: data.zipCode,
        fulfillment: data.fulfillment,
        lines: lines.length,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error("Failed to create Devin session for DICK'S checkout error", { error: err.message, orderId });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  findProduct,
  findMember,
  buildCartLines,
  computeShipping,
  computeTax,
  roundCurrency,
  resolveScoreCardTier,
  computeScoreCardEarn,
  applyScoreCardRewards,
  CATALOG,
  MEMBERS,
  STORES,
  SHIPPING,
  PAYMENT_METHODS,
  SCORECARD_TIERS,
  REWARD_CERTIFICATES,
};
