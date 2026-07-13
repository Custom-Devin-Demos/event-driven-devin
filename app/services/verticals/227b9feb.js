const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Mortgage product catalog. Each product defines the amortization
 * terms (in years) it can be offered at.
 */
const MORTGAGE_PRODUCTS = [
  { id: 'fixed-closed', label: 'Fixed Rate Closed', terms: [1, 2, 3, 4, 5, 7, 10], baseSpread: 0.0 },
  { id: 'variable-flex', label: 'Variable Flex', terms: [3, 5], baseSpread: -0.35 },
  { id: 'fixed-open', label: 'Fixed Rate Open', terms: [1], baseSpread: 1.85 },
];

/**
 * Posted rates by term (years). The prime-linked benchmark used to
 * derive each product's personalized rate.
 */
const POSTED_RATES = {
  1: { posted: 6.09, discountCap: 1.1 },
  2: { posted: 5.84, discountCap: 1.25 },
  3: { posted: 5.55, discountCap: 1.4 },
  5: { posted: 5.29, discountCap: 1.55 },
  7: { posted: 5.9, discountCap: 1.2 },
  10: { posted: 6.14, discountCap: 1.0 },
};

function findProduct(productId) {
  return MORTGAGE_PRODUCTS.find((p) => p.id === productId) || MORTGAGE_PRODUCTS[0];
}

/**
 * Build the rate schedule for a product across its available terms.
 * Only terms present in the posted-rate sheet are included in the
 * schedule — terms without a posted benchmark are skipped.
 */
function buildRateSchedule(product) {
  const schedule = {};

  for (const term of product.terms) {
    const benchmark = POSTED_RATES[term];

    if (benchmark) {
      schedule[term] = {
        term,
        posted: benchmark.posted,
        discountCap: benchmark.discountCap,
      };
    }
  }

  return schedule;
}

/**
 * Compute the personalized pre-approval rate for the requested term
 * from the product's rate schedule.
 */
function computePersonalRate(product, schedule, term, creditTier) {
  const entry = schedule[term];
  const tierDiscount = { excellent: 1.0, good: 0.75, fair: 0.4 }[creditTier] || 0.4;
  const discount = Math.min(entry.discountCap, tierDiscount);
  const rate = Math.round((entry.posted - discount + product.baseSpread) * 100) / 100;

  return { term, posted: entry.posted, discount, rate };
}

/**
 * Assemble the final pre-approval summary returned to the client.
 */
function assemblePreApproval(product, pricing, data) {
  const principal = data.amount;
  const monthlyRate = pricing.rate / 100 / 12;
  const numPayments = (data.amortization || 25) * 12;
  const payment = Math.round(((principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -numPayments))) * 100) / 100;

  return {
    preApprovalId: `CIBC-${uuidv4().slice(0, 8).toUpperCase()}`,
    product: product.label,
    term: `${pricing.term} year`,
    postedRate: pricing.posted,
    personalRate: pricing.rate,
    amount: principal,
    amortizationYears: data.amortization || 25,
    estimatedMonthlyPayment: payment,
    currency: 'CAD',
    holdPeriodDays: 120,
  };
}

/**
 * Processes a mortgage pre-approval rate quote request.
 */
async function processInquiry(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing mortgage pre-approval inquiry', {
    requestId,
    productId: data.productId,
    term: data.term,
    amount: data.amount,
    service: 'customer-227b9feb-banking',
    route: '/api/227b9feb/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const product = findProduct(data.productId);
    const schedule = buildRateSchedule(product);
    const pricing = computePersonalRate(product, schedule, data.term, data.creditTier);
    const summary = assemblePreApproval(product, pricing, data);

    summary.requestId = requestId;
    summary.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('mortgage_preapproval.success', {
      route: '/api/227b9feb/inquiry',
      product: product.id,
    });
    recordTiming('mortgage_preapproval.latency', duration, {
      route: '/api/227b9feb/inquiry',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('mortgage_preapproval.failure', {
      route: '/api/227b9feb/inquiry',
      errorClass: error.name,
    });
    recordTiming('mortgage_preapproval.latency', duration, {
      route: '/api/227b9feb/inquiry',
      error: 'true',
    });

    logger.error('Mortgage pre-approval inquiry failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      productId: data.productId,
      term: data.term,
      service: 'customer-227b9feb-banking',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/227b9feb/inquiry',
        service: 'customer-227b9feb-banking',
        product: data.productId,
      },
      extra: { requestId, term: data.term, amount: data.amount },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/227b9feb.js — computePersonalRate',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-227b9feb-banking',
      verticalLabel: 'Mortgage Pre-Approval',
      customer: '227b9feb',
      tags: [
        { key: 'route', value: '/api/227b9feb/inquiry' },
        { key: 'service', value: 'customer-227b9feb-banking' },
        { key: 'product', value: data.productId },
      ],
      extra: { requestId, term: data.term, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-227b9feb-banking@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for mortgage pre-approval error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processInquiry, MORTGAGE_PRODUCTS, POSTED_RATES };
