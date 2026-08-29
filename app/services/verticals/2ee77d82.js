const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Restaurant brand portfolio served by the corporate inquiry flow.
 */
const BRANDS = {
  kfc: {
    code: 'kfc',
    name: 'KFC',
    category: 'chicken',
    restaurants: 31000,
  },
  tacobell: {
    code: 'tacobell',
    name: 'Taco Bell',
    category: 'mexican-inspired',
    restaurants: 8800,
  },
  pizzahut: {
    code: 'pizzahut',
    name: 'Pizza Hut',
    category: 'pizza',
    restaurants: 20000,
  },
  habit: {
    code: 'habit',
    name: 'Habit Burger & Grill',
    category: 'burgers',
    restaurants: 380,
  },
};

/**
 * Market profiles keyed by ISO country code. Each profile carries the
 * franchise segment used to route corporate inquiries.
 */
const MARKET_PROFILES = {
  US: { region: 'north-america', currency: 'usd', segment: 'franchise_global' },
  CA: { region: 'north-america', currency: 'cad', segment: 'franchise_intl' },
  GB: { region: 'europe', currency: 'gbp', segment: 'franchise_intl' },
  AU: { region: 'apac', currency: 'aud', segment: 'franchise_intl' },
  IN: { region: 'apac', currency: 'inr', segment: 'franchise_intl' },
};

/**
 * Routing table mapping franchise segments to the corporate desk that
 * owns the follow-up, plus the brand set quoted in the response.
 */
const SEGMENT_ROUTING = {
  franchise_global: {
    desk: 'global-franchise-development',
    responseSlaHours: 24,
    brands: ['kfc', 'tacobell', 'pizzahut', 'habit'],
  },
  franchise_intl: {
    desk: 'international-development',
    responseSlaHours: 48,
    brands: ['kfc', 'pizzahut'],
  },
  investor_relations: {
    desk: 'investor-relations',
    responseSlaHours: 24,
    brands: ['kfc', 'tacobell', 'pizzahut', 'habit'],
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `Custom-Devin-Demos/event-driven-devin`',
  '',
  'The failing code path is the restaurant group corporate inquiry vertical:',
  '- Service: `app/services/verticals/2ee77d82.js`',
  '- Route: `app/routes/verticals/2ee77d82.js`',
  '- Page: `app/public/verticals/2ee77d82.html` (served at `/2ee77d82`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Resolve the market profile for the inquiring party.
 */
function resolveMarketProfile(market) {
  const key = String(market || 'US').toUpperCase();
  return MARKET_PROFILES[key] || MARKET_PROFILES.US;
}

/**
 * Resolve the corporate routing entry for a market profile.
 */
function resolveSegmentRouting(profile) {
  return SEGMENT_ROUTING[profile.segment] || SEGMENT_ROUTING.franchise_global;
}

/**
 * Build the brand mix quoted back to the requester for a routing entry.
 */
function buildBrandMix(routing) {
  return routing.brands.map((code) => {
    const brand = BRANDS[code];
    return {
      code: brand.code,
      name: brand.name,
      category: brand.category,
      restaurants: brand.restaurants,
    };
  });
}

/**
 * Build the confirmation payload returned to the corporate site.
 */
function buildInquirySummary(referenceNumber, profile, routing, brandMix) {
  return {
    success: true,
    referenceNumber,
    status: 'received',
    region: profile.region,
    desk: routing.desk,
    responseSlaHours: routing.responseSlaHours,
    brands: brandMix,
    receivedAt: new Date().toISOString(),
  };
}

/**
 * Handle a corporate inquiry submitted from the brand site.
 */
async function submitInquiry(data) {
  const startTime = Date.now();
  const referenceNumber = uuidv4();

  logger.info('Processing corporate inquiry', {
    referenceNumber,
    topic: data.topic,
    market: data.market,
    service: 'customer-2ee77d82-inquiry',
    route: '/api/2ee77d82/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const profile = resolveMarketProfile(data.market);
    const routing = resolveSegmentRouting(profile);
    const brandMix = buildBrandMix(routing);
    const summary = buildInquirySummary(referenceNumber, profile, routing, brandMix);

    const duration = Date.now() - startTime;

    incrementMetric('corporate_inquiry.success', {
      route: '/api/2ee77d82/inquiry',
      topic: data.topic,
    });
    recordTiming('corporate_inquiry.latency', duration, {
      route: '/api/2ee77d82/inquiry',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('corporate_inquiry.failure', {
      route: '/api/2ee77d82/inquiry',
      errorClass: error.name,
      topic: data.topic,
    });
    recordTiming('corporate_inquiry.latency', duration, {
      route: '/api/2ee77d82/inquiry',
      error: 'true',
    });

    logger.error('Corporate inquiry failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      topic: data.topic,
      market: data.market,
      service: 'customer-2ee77d82-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/2ee77d82/inquiry',
        service: 'customer-2ee77d82-inquiry',
        topic: data.topic,
      },
      extra: {
        referenceNumber,
        topic: data.topic,
        market: data.market,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/2ee77d82.js \u2014 buildBrandMix',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-2ee77d82-inquiry',
      verticalLabel: 'Restaurant Group Corporate Inquiry',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '2ee77d82',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/2ee77d82/inquiry' },
        { key: 'service', value: 'customer-2ee77d82-inquiry' },
        { key: 'topic', value: data.topic },
        { key: 'market', value: data.market },
      ],
      extra: {
        referenceNumber,
        topic: data.topic,
        market: data.market,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-2ee77d82-inquiry@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for corporate inquiry error', {
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
  BRANDS,
  MARKET_PROFILES,
  SEGMENT_ROUTING,
  resolveMarketProfile,
  resolveSegmentRouting,
  buildBrandMix,
};
