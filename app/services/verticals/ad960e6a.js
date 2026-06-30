const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Internet plan tiers with base monthly pricing and included features.
 */
const PLANS = {
  standard: { code: 'STD', downloadMbps: 300, baseMonthly: 70, term: 12 },
  performance: { code: 'PERF', downloadMbps: 500, baseMonthly: 100, term: 12, promo: { monthlyDiscount: 10, label: '1-year pricing' } },
  gigabit: { code: 'GIG', downloadMbps: 1250, baseMonthly: 150, term: 12, promo: { monthlyDiscount: 10, label: '1-year pricing' } },
  twogig: { code: '2GIG', downloadMbps: 2000, baseMonthly: 180, term: 12, promo: { monthlyDiscount: 10, label: '1-year pricing' } },
};

/**
 * Qualifying solutions that can be bundled for additional savings.
 */
const SOLUTIONS = [
  { id: 'securityedge', label: 'SecurityEdge\u2122 Preferred', price: 20, saves: 10 },
  { id: 'wirelessconnect', label: 'Wireless Connect', price: 35, saves: 10 },
  { id: 'mobile', label: 'Comcast Business Mobile', price: 20, saves: 10 },
];

function findPlan(planId) {
  return PLANS[planId] || PLANS.standard;
}

/**
 * Compute the monthly pricing breakdown for a plan and term.
 */
function computePlanPricing(plan, term) {
  const base = plan.baseMonthly;
  const autopayCredit = 10;
  const termFactor = term >= 12 ? 1 : 1.15;
  const monthly = base * termFactor - autopayCredit;

  return {
    code: plan.code,
    base,
    autopayCredit,
    termFactor,
    monthly: Math.round(monthly * 100) / 100,
    downloadMbps: plan.downloadMbps,
  };
}

/**
 * Build the savings summary, factoring in the promotional discount
 * applied to the selected plan tier.
 */
function buildSavingsSummary(plan, pricing, solutions) {
  const promo = plan.promo || { monthlyDiscount: 0, label: 'No current promotion' };
  const promoDiscount = promo.monthlyDiscount;
  const bundleSavings = solutions.reduce((sum, s) => sum + s.saves, 0);
  const effectiveMonthly = pricing.monthly - promoDiscount;

  return {
    promoLabel: promo.label,
    promoDiscount,
    bundleSavings,
    effectiveMonthly: Math.round(effectiveMonthly * 100) / 100,
    totalMonthlySavings: promoDiscount + bundleSavings,
  };
}

/**
 * Assemble the final quote shown to the prospective customer.
 */
function assembleQuote(plan, pricing, savings, solutions, term) {
  const solutionsCost = solutions.reduce((sum, s) => sum + s.price, 0);
  const monthlyTotal = savings.effectiveMonthly + solutionsCost - savings.bundleSavings;

  return {
    plan: plan.code,
    downloadMbps: pricing.downloadMbps,
    term,
    baseMonthly: pricing.base,
    promoLabel: savings.promoLabel,
    effectiveMonthly: savings.effectiveMonthly,
    solutions: solutions.map((s) => ({ label: s.label, price: s.price })),
    solutionsCost,
    totalMonthlySavings: savings.totalMonthlySavings,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
  };
}

/**
 * Processes a business internet quote request.
 */
async function processQuoteRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing internet quote request', {
    requestId,
    plan: data.plan,
    term: data.term,
    service: 'customer-ad960e6a-internet',
    route: '/api/ad960e6a/quote',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const plan = findPlan(data.plan);
    const pricing = computePlanPricing(plan, data.term);
    const selectedSolutions = (data.solutions || [])
      .map((id) => SOLUTIONS.find((s) => s.id === id))
      .filter(Boolean);
    const savings = buildSavingsSummary(plan, pricing, selectedSolutions);
    const quote = assembleQuote(plan, pricing, savings, selectedSolutions, data.term);

    quote.requestId = requestId;
    quote.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('internet_quote.success', {
      route: '/api/ad960e6a/quote',
      plan: data.plan,
    });
    recordTiming('internet_quote.latency', duration, {
      route: '/api/ad960e6a/quote',
    });

    return quote;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('internet_quote.failure', {
      route: '/api/ad960e6a/quote',
      errorClass: error.name,
    });
    recordTiming('internet_quote.latency', duration, {
      route: '/api/ad960e6a/quote',
      error: 'true',
    });

    logger.error('Internet quote failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      plan: data.plan,
      term: data.term,
      service: 'customer-ad960e6a-internet',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/ad960e6a/quote',
        service: 'customer-ad960e6a-internet',
        plan: data.plan,
      },
      extra: { requestId, plan: data.plan, term: data.term },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ad960e6a.js \u2014 buildSavingsSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-ad960e6a-internet',
      verticalLabel: 'Business Internet Quote',
      customer: 'ad960e6a',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/ad960e6a/quote' },
        { key: 'service', value: 'customer-ad960e6a-internet' },
        { key: 'plan', value: data.plan },
      ],
      extra: { requestId, plan: data.plan, term: data.term },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-ad960e6a-internet@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for internet quote error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processQuoteRequest, buildSavingsSummary, findPlan, computePlanPricing, PLANS, SOLUTIONS };
