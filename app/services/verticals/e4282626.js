const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-e4282626-rate-comparison';
const ROUTE = '/api/e4282626/inquiry';
const SLACK_MEMBER_ID = 'U08S7AVJ478';

const PLAN_TYPES = {
  G: { label: 'Plan G', preferredCarrier: 'aetna', deductibleUsd: 257 },
  N: { label: 'Plan N', preferredCarrier: 'cigna', deductibleUsd: 257 },
  F: { label: 'Plan F', preferredCarrier: 'mutual', deductibleUsd: 0 },
};

const CARRIER_RATE_CARDS = {
  KS: [
    {
      carrierId: 'aetna',
      carrierName: 'Aetna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 142, N: 112, F: 186 },
      householdDiscountPct: 7,
    },
    {
      carrierId: 'cigna',
      carrierName: 'Cigna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 148, N: 116, F: 191 },
      householdDiscountPct: 8,
    },
    {
      carrierId: 'healthspring',
      carrierName: 'HealthSpring',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 153, N: 120, F: 197 },
      householdDiscountPct: 5,
    },
    {
      carrierId: 'aflac',
      carrierName: 'Aflac',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 159, N: 124, F: 202 },
      householdDiscountPct: 6,
    },
    {
      carrierId: 'mutual',
      carrierName: 'Mutual of Omaha',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 146, N: 114, F: 188 },
      householdDiscountPct: 9,
    },
  ],
  MO: [
    {
      carrierId: 'aetna',
      carrierName: 'Aetna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 151, N: 119, F: 194 },
      householdDiscountPct: 7,
    },
    {
      carrierId: 'cigna',
      carrierName: 'Cigna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 157, N: 123, F: 201 },
      householdDiscountPct: 8,
    },
    {
      carrierId: 'healthspring',
      carrierName: 'HealthSpring',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 162, N: 127, F: 207 },
      householdDiscountPct: 5,
    },
    {
      carrierId: 'aflac',
      carrierName: 'Aflac',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 168, N: 131, F: 213 },
      householdDiscountPct: 6,
    },
    {
      carrierId: 'mutual',
      carrierName: 'Mutual of Omaha',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 155, N: 121, F: 197 },
      householdDiscountPct: 9,
    },
  ],
  TX: [
    {
      carrierId: 'aetna',
      carrierName: 'Aetna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 134, N: 106, F: 178 },
      householdDiscountPct: 7,
    },
    {
      carrierId: 'cigna',
      carrierName: 'Cigna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 139, N: 109, F: 183 },
      householdDiscountPct: 8,
    },
    {
      carrierId: 'healthspring',
      carrierName: 'HealthSpring',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 145, N: 113, F: 189 },
      householdDiscountPct: 5,
    },
    {
      carrierId: 'aflac',
      carrierName: 'Aflac',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 151, N: 117, F: 195 },
      householdDiscountPct: 6,
    },
    {
      carrierId: 'mutual',
      carrierName: 'Mutual of Omaha',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 137, N: 107, F: 180 },
      householdDiscountPct: 9,
    },
  ],
  FL: [
    {
      carrierId: 'aetna',
      carrierName: 'Aetna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 164, N: 129, F: 214 },
      householdDiscountPct: 7,
    },
    {
      carrierId: 'cigna',
      carrierName: 'Cigna',
      amBestRating: 'A',
      monthlyPremiumUsd: { G: 171, N: 134, F: 221 },
      householdDiscountPct: 8,
    },
    {
      carrierId: 'healthspring',
      carrierName: 'HealthSpring',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 177, N: 139, F: 228 },
      householdDiscountPct: 5,
    },
    {
      carrierId: 'aflac',
      carrierName: 'Aflac',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 183, N: 143, F: 235 },
      householdDiscountPct: 6,
    },
    {
      carrierId: 'mutual',
      carrierName: 'Mutual of Omaha',
      amBestRating: 'A+',
      monthlyPremiumUsd: { G: 168, N: 131, F: 217 },
      householdDiscountPct: 9,
    },
  ],
};

const ZIP_PREFIX_STATES = {
  '66': 'KS',
  '67': 'KS',
  '63': 'MO',
  '64': 'MO',
  '75': 'TX',
  '77': 'TX',
  '33': 'FL',
  '32': 'FL',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Medicare plan brokerage marketing-site rate comparison vertical:',
  '- Service: `app/services/verticals/e4282626.js`',
  '- Route: `app/routes/verticals/e4282626.js`',
  '- Page: `app/public/verticals/e4282626.html` (served at `/e4282626`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function resolveState(zip) {
  const prefix = String(zip || '').trim().slice(0, 2);
  return ZIP_PREFIX_STATES[prefix] || 'KS';
}

function quoteCarriers(state, planCode) {
  const resolvedPlanCode = PLAN_TYPES[planCode] ? planCode : 'G';
  const cards = CARRIER_RATE_CARDS[state] || CARRIER_RATE_CARDS.KS;

  return cards.map((card) => ({
    carrierId: card.carrierId,
    carrierName: card.carrierName,
    amBestRating: card.amBestRating,
    monthlyPremiumUsd: card.monthlyPremiumUsd[resolvedPlanCode],
    householdDiscountPct: card.householdDiscountPct,
  }));
}

/**
 * Index quotes by carrier so the lead-rate lookup is O(1).
 */
function buildCarrierIndex(quotes) {
  const index = {};

  for (const quote of quotes) {
    index[quote.carrier] = quote;
  }

  return index;
}

function selectLeadRate(carrierIndex, plan) {
  const lead = carrierIndex[plan.preferredCarrier];

  return {
    carrierName: lead.carrierName,
    monthlyPremiumUsd: lead.monthlyPremiumUsd,
    amBestRating: lead.amBestRating,
    householdDiscountPct: lead.householdDiscountPct,
  };
}

function rankByPremium(quotes) {
  return [...quotes].sort((a, b) => a.monthlyPremiumUsd - b.monthlyPremiumUsd);
}

function estimateAnnualSavings(quotes, lead) {
  const lowestPremium = Math.min(...quotes.map((quote) => quote.monthlyPremiumUsd));
  return Math.max(0, Math.round((lead.monthlyPremiumUsd - lowestPremium) * 12 * 100) / 100);
}

async function compareRates(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();
  const zip = data.zip || '66210';
  const planCode = data.planCode || 'G';

  logger.info('Processing Medicare plan rate comparison', {
    inquiryId,
    zip,
    planCode,
    age: data.age,
    tobacco: data.tobacco,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const state = resolveState(zip);
    const plan = PLAN_TYPES[planCode] || PLAN_TYPES.G;
    const quotes = quoteCarriers(state, planCode);
    const carrierIndex = buildCarrierIndex(quotes);
    const lead = selectLeadRate(carrierIndex, plan);
    const rankedQuotes = rankByPremium(quotes);
    const estimatedAnnualSavings = estimateAnnualSavings(quotes, lead);
    const duration = Date.now() - startTime;

    incrementMetric('rate_comparison.success', { route: ROUTE, plan: planCode, state });
    recordTiming('rate_comparison.latency', duration, { route: ROUTE });

    return {
      success: true,
      inquiryId,
      zip,
      state,
      plan: plan.label,
      deductibleUsd: plan.deductibleUsd,
      lead,
      quotes: rankedQuotes,
      estimatedAnnualSavings,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const state = resolveState(zip);

    incrementMetric('rate_comparison.failure', {
      route: ROUTE,
      errorClass: error.name,
      plan: planCode,
      state,
    });
    recordTiming('rate_comparison.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Medicare plan rate comparison failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      zip,
      planCode,
      state,
      age: data.age,
      tobacco: data.tobacco,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        plan: planCode,
        state,
        alert_path: 'instant',
      },
      extra: {
        inquiryId,
        zip,
        planCode,
        age: data.age,
        tobacco: data.tobacco,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e4282626.js \u2014 selectLeadRate',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Rate Comparison',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'e4282626',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'plan', value: planCode },
        { key: 'state', value: state },
      ],
      extra: {
        inquiryId,
        zip,
        planCode,
        age: data.age,
        tobacco: data.tobacco,
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
      logger.error('Failed to create Devin session for rate comparison error', {
        error: err.message,
        inquiryId,
      });
    });

    throw error;
  }
}

module.exports = {
  compareRates,
  REMEDIATION_DIRECTIVE,
  PLAN_TYPES,
  CARRIER_RATE_CARDS,
  ZIP_PREFIX_STATES,
  resolveState,
  quoteCarriers,
  buildCarrierIndex,
  selectLeadRate,
  rankByPremium,
  estimateAnnualSavings,
};
