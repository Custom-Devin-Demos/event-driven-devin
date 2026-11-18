/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.DEFINITY_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-2fbca1a9-coverage-quote';
const ROUTE = '/api/2fbca1a9/coverage-quote';

const LATENCY_SLO = { budgetMs: 3000 };
const RATING_ENGINE_POLICY = { latencyMs: [450, 550] };

const PRODUCTS = {
  auto: { label: 'Auto', basePremium: 1680 },
  home: { label: 'Home', basePremium: 1420 },
  business: { label: 'Small Business', basePremium: 2950 },
  farm: { label: 'Farm', basePremium: 4100 },
  pet: { label: 'Pet', basePremium: 640 },
};

const PROVINCES = {
  ON: { label: 'Ontario', factor: 1.18 },
  QC: { label: 'Quebec', factor: 0.94 },
  AB: { label: 'Alberta', factor: 1.07 },
  BC: { label: 'British Columbia', factor: 1.02 },
  MB: { label: 'Manitoba', factor: 0.91 },
  SK: { label: 'Saskatchewan', factor: 0.9 },
  NS: { label: 'Nova Scotia', factor: 0.97 },
  NB: { label: 'New Brunswick', factor: 0.95 },
  NL: { label: 'Newfoundland and Labrador', factor: 1.04 },
  PE: { label: 'Prince Edward Island', factor: 0.89 },
};

const RATING_PROGRAMS = [
  { code: 'DEF-AUTO-PREF', brand: 'Definity Insurance', program: 'Preferred Auto', product: 'auto', factor: 0.96 },
  { code: 'DEF-AUTO-STD', brand: 'Definity Insurance', program: 'Standard Auto', product: 'auto', factor: 1.04 },
  { code: 'DEF-HOME-PREST', brand: 'Definity Insurance', program: 'Prestige Home', product: 'home', factor: 1.12 },
  { code: 'DEF-HOME-STD', brand: 'Definity Insurance', program: 'Homeowners', product: 'home', factor: 0.98 },
  { code: 'DEF-BUS-SME', brand: 'Definity Insurance', program: 'Commercial Small Business', product: 'business', factor: 1 },
  { code: 'DEF-FARM', brand: 'Definity Insurance', program: 'Farm & Agribusiness', product: 'farm', factor: 1 },
  { code: 'SON-AUTO', brand: 'Sonnet', program: 'Sonnet Car Insurance', product: 'auto', factor: 0.93 },
  { code: 'SON-HOME', brand: 'Sonnet', program: 'Sonnet Home Insurance', product: 'home', factor: 0.95 },
  { code: 'FAM-AUTO', brand: 'Family', program: 'Family Auto', product: 'auto', factor: 0.99 },
  { code: 'FAM-HOME', brand: 'Family', program: 'Family Home', product: 'home', factor: 1.01 },
  { code: 'TRV-AUTO', brand: 'Travelers Canada', program: 'Personal Auto (Travelers)', product: 'auto', factor: 1.06 },
  { code: 'TRV-HOME', brand: 'Travelers Canada', program: 'Personal Home (Travelers)', product: 'home', factor: 1.03 },
  { code: 'PET-ACC-ILL', brand: 'Petline', program: 'Accident & Illness', product: 'pet', factor: 1 },
  { code: 'PET-ACC', brand: 'Petline', program: 'Accident Only', product: 'pet', factor: 0.62 },
];

const QUOTE_CHANNELS = {
  all: { label: 'All Definity companies', programs: RATING_PROGRAMS.map((program) => program.code) },
  definity: {
    label: 'Definity Insurance (through a broker)',
    programs: { auto: ['DEF-AUTO-PREF'], home: ['DEF-HOME-STD'], business: ['DEF-BUS-SME'], farm: ['DEF-FARM'] },
  },
  sonnet: { label: 'Sonnet (online)', programs: { auto: ['SON-AUTO'], home: ['SON-HOME'] } },
  family: { label: 'Family Insurance', programs: { auto: ['FAM-AUTO'], home: ['FAM-HOME'] } },
  petline: { label: 'Petline Insurance', programs: { pet: ['PET-ACC-ILL'] } },
};

const POSTAL_CODE_PATTERN = /^[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d$/;

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Definity coverage quote request:',
  '- Service: `app/services/verticals/2fbca1a9.js`',
  '- Route: `app/routes/verticals/2fbca1a9.js`',
  '- Page: `app/public/verticals/2fbca1a9.html` (served at `/definity`)',
  '- Test: `tests/2fbca1a9-coverage-quote.test.js`',
  '',
  'Coverage quotes with the default "All Definity companies" channel succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `collectProgramQuotes` and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-call rating-engine latency.',
  'Preserve the response payload for every channel, including rating-program order and the lowest-premium tie-break (earliest program wins).',
  'Run `npx jest tests/2fbca1a9-coverage-quote.test.js --runInBand` and `npm run lint`.',
  'Verify the default quote at `/definity` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashRatingInput(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function rateProgram(code, request) {
  const [min, max] = RATING_ENGINE_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const program = RATING_PROGRAMS.find((entry) => entry.code === code);
  if (program.product !== request.product) {
    return {
      code, brand: program.brand, program: program.program, offered: false, annualPremium: null, monthlyPremium: null,
    };
  }

  const hash = hashRatingInput(`${code}:${request.product}:${request.province}:${request.postalCode}`);
  const variance = 0.92 + (hash % 17) / 100;
  const annualPremium = Math.round(
    PRODUCTS[request.product].basePremium * PROVINCES[request.province].factor * program.factor * variance,
  );

  return {
    code,
    brand: program.brand,
    program: program.program,
    offered: true,
    annualPremium,
    monthlyPremium: Math.round((annualPremium / 12) * 100) / 100,
  };
}

/**
 * Rate each program in RATING_PROGRAMS order; selectBestQuote breaks premium
 * ties by that order.
 */
async function collectProgramQuotes(codes, request) {
  const quotes = [];
  for (const code of codes) {
    quotes.push(await rateProgram(code, request));
  }
  return quotes;
}

function selectBestQuote(quotes) {
  return quotes.reduce((best, quote) => {
    if (!quote.offered) return best;
    if (!best || quote.annualPremium < best.annualPremium) return quote;
    return best;
  }, null);
}

function resolvePrograms(channel, product) {
  const option = QUOTE_CHANNELS[channel];
  return Array.isArray(option.programs) ? option.programs : (option.programs[product] || []);
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function validateQuoteRequest(data) {
  const valid = Object.hasOwn(PRODUCTS, data.product)
    && Object.hasOwn(PROVINCES, data.province)
    && POSTAL_CODE_PATTERN.test(data.postalCode)
    && Object.hasOwn(QUOTE_CHANNELS, data.channel);

  if (!valid) {
    throw validationError('Enter a valid product, province, postal code and channel.', 'QUOTE_DETAILS_INVALID');
  }
  if (resolvePrograms(data.channel, data.product).length === 0) {
    throw validationError(
      `${QUOTE_CHANNELS[data.channel].label} does not offer ${PRODUCTS[data.product].label} insurance.`,
      'PRODUCT_NOT_OFFERED',
    );
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, programsRated, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      product: data.product,
      channel: data.channel,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      programsRated,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/2fbca1a9.js — collectProgramQuotes',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Definity Coverage Quote',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '2fbca1a9',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'product', value: data.product },
      { key: 'channel', value: data.channel },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      programsRated,
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
    logger.error('Failed to create Devin session for Definity coverage-quote latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function quoteCoverage(data = {}) {
  const startTime = Date.now();
  const quoteId = `DFN-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    product: String(requestData.product || 'auto').trim().toLowerCase(),
    province: String(requestData.province || 'ON').trim().toUpperCase(),
    postalCode: String(requestData.postalCode === undefined ? 'M5H 2N2' : requestData.postalCode)
      .trim().toUpperCase().replace(/\s+/g, ' '),
    channel: String(requestData.channel || 'all').trim().toLowerCase(),
  };

  validateQuoteRequest(normalized);

  const codes = resolvePrograms(normalized.channel, normalized.product);

  logger.info('Rating Definity coverage quote', {
    quoteId,
    product: normalized.product,
    province: normalized.province,
    channel: normalized.channel,
    programs: codes.length,
    service: SERVICE,
    route: ROUTE,
  });

  const programQuotes = await collectProgramQuotes(codes, normalized);
  const bestQuote = selectBestQuote(programQuotes);
  const durationMs = Date.now() - startTime;

  incrementMetric('coverage_quote.success', {
    route: ROUTE,
    product: normalized.product,
    channel: normalized.channel,
  });
  recordTiming('coverage_quote.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('coverage_quote.latency_budget_breach', {
      route: ROUTE,
      product: normalized.product,
      channel: normalized.channel,
    });
    logger.warn('Definity coverage quote exceeded latency budget — triggering Devin', {
      quoteId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      programsRated: programQuotes.length,
      product: normalized.product,
      channel: normalized.channel,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: quoteId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      programsRated: programQuotes.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    quoteId,
    product: { key: normalized.product, label: PRODUCTS[normalized.product].label },
    province: { key: normalized.province, label: PROVINCES[normalized.province].label },
    postalCode: normalized.postalCode,
    channel: { key: normalized.channel, label: QUOTE_CHANNELS[normalized.channel].label },
    programsRated: programQuotes.length,
    programsOffering: programQuotes.filter((quote) => quote.offered).length,
    programQuotes,
    bestQuote,
    currency: 'CAD',
    durationMs,
  };
}

module.exports = {
  quoteCoverage,
  selectBestQuote,
  PRODUCTS,
  PROVINCES,
  RATING_PROGRAMS,
  QUOTE_CHANNELS,
  RATING_ENGINE_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
