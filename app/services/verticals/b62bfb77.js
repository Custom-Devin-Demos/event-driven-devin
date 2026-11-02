/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.ROCKET_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-b62bfb77-rate-check';
const ROUTE = '/api/b62bfb77/rate-check';

const LATENCY_SLO = { budgetMs: 3000 };
const PRICING_DESK_POLICY = { latencyMs: [450, 550] };

const LOAN_PROGRAMS = {
  conv30: { label: '30-year fixed', family: 'Conventional', termYears: 30, baseRate: 6.375, minDownPct: 3, feesPct: 0.9 },
  conv20: { label: '20-year fixed', family: 'Conventional', termYears: 20, baseRate: 6.125, minDownPct: 3, feesPct: 0.9 },
  conv15: { label: '15-year fixed', family: 'Conventional', termYears: 15, baseRate: 5.625, minDownPct: 3, feesPct: 0.9 },
  conv10: { label: '10-year fixed', family: 'Conventional', termYears: 10, baseRate: 5.5, minDownPct: 3, feesPct: 0.9 },
  arm76: { label: '7/6 ARM', family: 'Adjustable', termYears: 30, baseRate: 5.875, minDownPct: 5, feesPct: 1.0 },
  arm56: { label: '5/6 ARM', family: 'Adjustable', termYears: 30, baseRate: 5.75, minDownPct: 5, feesPct: 1.0 },
  fha30: { label: 'FHA 30-year fixed', family: 'FHA', termYears: 30, baseRate: 5.99, minDownPct: 3.5, feesPct: 2.75 },
  fha15: { label: 'FHA 15-year fixed', family: 'FHA', termYears: 15, baseRate: 5.5, minDownPct: 3.5, feesPct: 2.75 },
  va30: { label: 'VA 30-year fixed', family: 'VA', termYears: 30, baseRate: 5.875, minDownPct: 0, feesPct: 2.15 },
  va15: { label: 'VA 15-year fixed', family: 'VA', termYears: 15, baseRate: 5.375, minDownPct: 0, feesPct: 2.15 },
  usda30: { label: 'USDA 30-year fixed', family: 'USDA', termYears: 30, baseRate: 6.0, minDownPct: 0, feesPct: 1.0 },
  jumbo30: { label: 'Jumbo 30-year fixed', family: 'Jumbo', termYears: 30, baseRate: 6.5, minDownPct: 10, feesPct: 0.75 },
  jumbo15: { label: 'Jumbo 15-year fixed', family: 'Jumbo', termYears: 15, baseRate: 6.0, minDownPct: 10, feesPct: 0.75 },
  oneplus: { label: 'ONE+ 30-year fixed (1% down)', family: 'Conventional', termYears: 30, baseRate: 6.625, minDownPct: 1, feesPct: 1.1 },
};

const ALL_PROGRAMS = Object.keys(LOAN_PROGRAMS);

const PROGRAM_SCOPES = {
  all: { label: `All loan programs (${ALL_PROGRAMS.length})`, programs: ALL_PROGRAMS },
  ...Object.fromEntries(ALL_PROGRAMS.map((key) => [key, { label: LOAN_PROGRAMS[key].label, programs: [key] }])),
};

const CREDIT_BANDS = {
  excellent: { label: 'Excellent (740+)', rateAdjust: 0 },
  good: { label: 'Good (680–739)', rateAdjust: 0.375 },
  fair: { label: 'Fair (620–679)', rateAdjust: 0.875 },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Rocket Mortgage rate check request:',
  '- Service: `app/services/verticals/b62bfb77.js`',
  '- Route: `app/routes/verticals/b62bfb77.js`',
  '- Page: `app/public/verticals/b62bfb77.html` (served at `/rocket`)',
  '- Test: `tests/b62bfb77-rate-check.test.js`',
  '',
  'Rate checks with the default "All loan programs" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call via Datadog / Sentry.',
  'The culprit is `priceLoanPrograms` in the service.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-program pricing desk latency.',
  'Preserve the response payload for every scope, including the order of per-program quotes and the summary (lowest rate / lowest payment).',
  'Run `npx jest tests/b62bfb77-rate-check.test.js --runInBand` and `npm run lint`.',
  'Verify the default rate check at `/rocket` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashQuote(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function monthlyPaymentCents(principalCents, annualRatePct, termYears) {
  const r = annualRatePct / 100 / 12;
  const n = termYears * 12;
  return Math.round((principalCents * r) / (1 - (1 + r) ** -n));
}

async function fetchProgramPricing(request, programKey) {
  const [min, max] = PRICING_DESK_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const program = LOAN_PROGRAMS[programKey];
  const downCents = Math.round(request.downPayment * 100);
  const priceCents = Math.round(request.homePrice * 100);
  const loanAmountCents = priceCents - downCents;
  const meetsDownPct = (pct) => downCents * 1000 >= Math.round(pct * 10) * priceCents;

  if (!meetsDownPct(program.minDownPct)) {
    return {
      program: programKey,
      label: program.label,
      family: program.family,
      termYears: program.termYears,
      status: 'not_eligible',
      reason: `Requires at least ${program.minDownPct}% down`,
      rate: null,
      apr: null,
      points: null,
      monthlyPaymentCents: null,
    };
  }

  const hash = hashQuote(`${request.zip}:${request.creditBand}:${programKey}`);
  const marketAdjust = ((hash % 7) - 3) * 0.0625;
  const ltvAdjust = meetsDownPct(20) ? 0 : 0.125;
  const rate = Math.round((program.baseRate + marketAdjust + ltvAdjust
    + CREDIT_BANDS[request.creditBand].rateAdjust) * 1000) / 1000;
  const points = Math.round((((hash >>> 6) % 9) * 0.125) * 1000) / 1000;
  const apr = Math.round((rate + (program.feesPct + points) / program.termYears * 1.1) * 1000) / 1000;

  return {
    program: programKey,
    label: program.label,
    family: program.family,
    termYears: program.termYears,
    status: 'priced',
    reason: null,
    rate,
    apr,
    points,
    monthlyPaymentCents: monthlyPaymentCents(loanAmountCents, rate, program.termYears),
  };
}

/**
 * Request a locked quote for each loan program from the Rocket Mortgage pricing
 * desk. Quotes are returned in the scope's program order so the rate table on
 * the page lines up with the program menu.
 */
async function priceLoanPrograms(request, programs) {
  const quotes = [];
  for (const programKey of programs) {
    quotes.push(await fetchProgramPricing(request, programKey));
  }
  return quotes;
}

function summarize(quotes) {
  const priced = quotes.filter((q) => q.status === 'priced');
  const lowestRate = priced.reduce((best, q) => (!best || q.rate < best.rate ? q : best), null);
  const lowestPayment = priced.reduce(
    (best, q) => (!best || q.monthlyPaymentCents < best.monthlyPaymentCents ? q : best),
    null,
  );
  return {
    programsQuoted: quotes.length,
    eligiblePrograms: priced.length,
    lowestRate: lowestRate ? { program: lowestRate.program, label: lowestRate.label, rate: lowestRate.rate, apr: lowestRate.apr } : null,
    lowestPayment: lowestPayment
      ? { program: lowestPayment.program, label: lowestPayment.label, monthlyPaymentCents: lowestPayment.monthlyPaymentCents }
      : null,
  };
}

const isWholeCents = (value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

function validateRateCheck(data) {
  const validName = typeof data.name === 'string' && data.name.length >= 2 && data.name.length <= 80;
  const validPrice = Number.isFinite(data.homePrice) && data.homePrice >= 50000 && data.homePrice <= 5000000 && isWholeCents(data.homePrice);
  const validDown = Number.isFinite(data.downPayment) && data.downPayment >= 0 && data.downPayment < data.homePrice && isWholeCents(data.downPayment);
  const validZip = /^\d{5}$/.test(data.zip);
  const validCredit = Object.hasOwn(CREDIT_BANDS, data.creditBand);
  const validScope = Object.hasOwn(PROGRAM_SCOPES, data.scope);

  if (!validName || !validPrice || !validDown || !validZip || !validCredit || !validScope) {
    const error = new Error('Enter your name, a home price between $50,000 and $5,000,000, a down payment below the home price, a 5-digit ZIP code, a credit range and a loan program.');
    error.name = 'ValidationError';
    error.code = 'RATE_CHECK_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, programsQuoted, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      scope: data.scope,
      credit_band: data.creditBand,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      programsQuoted,
      zip: data.zip,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/b62bfb77.js — priceLoanPrograms',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Rocket Mortgage Rate Check',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'b62bfb77',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'credit_band', value: data.creditBand },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      programsQuoted,
      datadogMetric: 'rate_check.latency',
    },
    level: 'warning',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for Rocket rate-check latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

function toNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  return Number(value);
}

async function runRateCheck(data = {}) {
  const startTime = Date.now();
  const quoteId = `RKT-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    name: requestData.name === undefined || requestData.name === null ? 'Jordan Lee' : String(requestData.name).trim(),
    homePrice: toNumber(requestData.homePrice, 425000),
    downPayment: toNumber(requestData.downPayment, 85000),
    zip: String(requestData.zip === undefined ? '48226' : requestData.zip).trim(),
    creditBand: String(requestData.creditBand === undefined ? 'excellent' : requestData.creditBand).trim().toLowerCase(),
    scope: String(requestData.scope === undefined ? 'all' : requestData.scope).trim().toLowerCase(),
  };

  validateRateCheck(normalized);

  const scope = PROGRAM_SCOPES[normalized.scope];

  logger.info('Running Rocket Mortgage rate check', {
    quoteId,
    zip: normalized.zip,
    creditBand: normalized.creditBand,
    scope: normalized.scope,
    programs: scope.programs.length,
    service: SERVICE,
    route: ROUTE,
  });

  const quotes = await priceLoanPrograms(normalized, scope.programs);
  const summary = summarize(quotes);
  const durationMs = Date.now() - startTime;

  incrementMetric('rate_check.success', { route: ROUTE, scope: normalized.scope, credit_band: normalized.creditBand });
  recordTiming('rate_check.latency', durationMs, { route: ROUTE, scope: normalized.scope });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('rate_check.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
      credit_band: normalized.creditBand,
    });
    logger.warn('Rocket Mortgage rate check exceeded latency budget', {
      quoteId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      programsQuoted: quotes.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    logger.warn('Rocket Mortgage rate check latency breach — triggering Devin session', {
      quoteId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: quoteId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      programsQuoted: quotes.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    quoteId,
    name: normalized.name,
    homePrice: normalized.homePrice,
    downPayment: normalized.downPayment,
    loanAmount: normalized.homePrice - normalized.downPayment,
    zip: normalized.zip,
    creditBand: { key: normalized.creditBand, label: CREDIT_BANDS[normalized.creditBand].label },
    scope: { key: normalized.scope, label: scope.label },
    programsQuoted: quotes.length,
    quotes,
    summary,
    durationMs,
  };
}

module.exports = {
  runRateCheck,
  summarize,
  monthlyPaymentCents,
  LOAN_PROGRAMS,
  ALL_PROGRAMS,
  PROGRAM_SCOPES,
  CREDIT_BANDS,
  PRICING_DESK_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
