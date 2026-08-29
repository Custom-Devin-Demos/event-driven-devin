const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Product lines available through the sales inquiry flow.
 */
const PRODUCTS = {
  payments: {
    code: 'payments',
    name: 'Payments',
    description: 'Accept and optimize payments, globally',
    settlement: 'standard',
  },
  billing: {
    code: 'billing',
    name: 'Billing',
    description: 'Subscriptions and usage-based revenue models',
    settlement: 'standard',
  },
  connect: {
    code: 'connect',
    name: 'Connect',
    description: 'Payments for platforms and marketplaces',
    settlement: 'platform',
  },
  issuing: {
    code: 'issuing',
    name: 'Issuing',
    description: 'Commercial card issuing programs',
    settlement: 'platform',
  },
  terminal: {
    code: 'terminal',
    name: 'Terminal',
    description: 'Unified online and in-person payments',
    settlement: 'standard',
  },
};

/**
 * Region profiles keyed by ISO country code. Each profile carries the
 * settlement currency and regulatory region used for pricing.
 */
const REGION_PROFILES = {
  US: { region: 'north-america', currency: 'usd', crossBorder: false },
  CA: { region: 'north-america', currency: 'cad', crossBorder: true },
  GB: { region: 'europe', currency: 'gbp', crossBorder: true },
  DE: { region: 'europe', currency: 'eur', crossBorder: true },
  AU: { region: 'apac', currency: 'aud', crossBorder: true },
  SG: { region: 'apac', currency: 'sgd', crossBorder: true },
};

/**
 * Published fee schedules by settlement lane.
 */
const FEE_SCHEDULES = {
  'standard-domestic': { percentage: 2.9, fixed: 0.3, label: 'Standard domestic card processing' },
  'standard-cross-border': { percentage: 3.9, fixed: 0.3, label: 'Standard cross-border card processing' },
  'platform-domestic': { percentage: 2.9, fixed: 0.3, label: 'Platform domestic processing' },
  'platform-cross-border': { percentage: 3.9, fixed: 0.3, label: 'Platform cross-border processing' },
};

/**
 * Estimated monthly volume tiers quoted during sales inquiries.
 */
const VOLUME_TIERS = [
  { tier: 'launch', maxMonthlyUsd: 100000, discount: 0 },
  { tier: 'growth', maxMonthlyUsd: 1000000, discount: 0.1 },
  { tier: 'scale', maxMonthlyUsd: 10000000, discount: 0.2 },
  { tier: 'enterprise', maxMonthlyUsd: Infinity, discount: 0.35 },
];

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `Custom-Devin-Demos/event-driven-devin`',
  '',
  'The failing code path is the payments platform sales inquiry vertical:',
  '- Service: `app/services/verticals/63f3f711.js`',
  '- Route: `app/routes/verticals/63f3f711.js`',
  '- Page: `app/public/verticals/63f3f711.html` (served at `/63f3f711`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findProduct(code) {
  return PRODUCTS[code] || null;
}

/**
 * Resolve the region profile for the inquiring merchant.
 */
function resolveRegionProfile(country) {
  const key = String(country || 'US').toUpperCase();
  return REGION_PROFILES[key] || REGION_PROFILES.US;
}

/**
 * Build the settlement lane identifier for a product and region pairing.
 */
function buildSettlementLane(product, profile) {
  const scope = profile.crossBorder ? 'cross_border' : 'domestic';
  return `${product.settlement}_${scope}`;
}

/**
 * Resolve the volume tier for the merchant's estimated monthly volume.
 */
function resolveVolumeTier(estimatedMonthlyUsd) {
  const volume = Number(estimatedMonthlyUsd) || 50000;
  return VOLUME_TIERS.find((entry) => volume <= entry.maxMonthlyUsd) || VOLUME_TIERS[0];
}

/**
 * Price the inquiry: effective rate after volume discounts, plus the
 * published schedule the quote is based on.
 */
function buildRateQuote(product, profile, volumeTier) {
  const lane = buildSettlementLane(product, profile);
  const schedule = FEE_SCHEDULES[lane];
  const effectivePercentage = schedule.percentage * (1 - volumeTier.discount);

  return {
    lane,
    scheduleLabel: schedule.label,
    currency: profile.currency,
    listPercentage: schedule.percentage,
    effectivePercentage: Math.round(effectivePercentage * 100) / 100,
    fixedFee: schedule.fixed,
    volumeTier: volumeTier.tier,
  };
}

/**
 * Build the confirmation payload returned to the marketing site.
 */
function buildInquirySummary(referenceNumber, product, profile, quote) {
  return {
    success: true,
    referenceNumber,
    status: 'received',
    product: product.name,
    productDescription: product.description,
    region: profile.region,
    quote,
    followUpWithinHours: 24,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Handle a sales inquiry submitted from the marketing site.
 */
async function submitInquiry(data) {
  const startTime = Date.now();
  const referenceNumber = uuidv4();

  const product = findProduct(data.product) || PRODUCTS.payments;

  logger.info('Processing sales inquiry', {
    referenceNumber,
    product: product.code,
    country: data.country,
    service: 'customer-63f3f711-inquiry',
    route: '/api/63f3f711/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const profile = resolveRegionProfile(data.country);
    const volumeTier = resolveVolumeTier(data.estimatedMonthlyUsd);
    const quote = buildRateQuote(product, profile, volumeTier);
    const summary = buildInquirySummary(referenceNumber, product, profile, quote);

    const duration = Date.now() - startTime;

    incrementMetric('sales_inquiry.success', {
      route: '/api/63f3f711/inquiry',
      product: product.code,
    });
    recordTiming('sales_inquiry.latency', duration, {
      route: '/api/63f3f711/inquiry',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('sales_inquiry.failure', {
      route: '/api/63f3f711/inquiry',
      errorClass: error.name,
      product: product.code,
    });
    recordTiming('sales_inquiry.latency', duration, {
      route: '/api/63f3f711/inquiry',
      error: 'true',
    });

    logger.error('Sales inquiry failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      product: product.code,
      country: data.country,
      service: 'customer-63f3f711-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/63f3f711/inquiry',
        service: 'customer-63f3f711-inquiry',
        product: product.code,
      },
      extra: {
        referenceNumber,
        product: product.code,
        country: data.country,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/63f3f711.js \u2014 buildRateQuote',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-63f3f711-inquiry',
      verticalLabel: 'Payments Sales Inquiry',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '63f3f711',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/63f3f711/inquiry' },
        { key: 'service', value: 'customer-63f3f711-inquiry' },
        { key: 'product', value: product.code },
        { key: 'country', value: data.country },
      ],
      extra: {
        referenceNumber,
        product: product.code,
        country: data.country,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-63f3f711-inquiry@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for sales inquiry error', {
        error: err.message,
        referenceNumber,
      });
    });

    throw error;
  }
}

module.exports = {
  submitInquiry,
  REMEDIATION_DIRECTIVE,
  PRODUCTS,
  REGION_PROFILES,
  FEE_SCHEDULES,
  VOLUME_TIERS,
  resolveRegionProfile,
  buildSettlementLane,
  resolveVolumeTier,
  buildRateQuote,
};
