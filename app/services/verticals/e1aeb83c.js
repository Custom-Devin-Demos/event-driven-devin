/**
 * Customer e1aeb83c — digital subscription offer inquiry service.
 *
 * Resolves the offer a reader clicked on the subscribe page, prices it for
 * the selected billing cadence, applies the active acquisition promotion and
 * returns a quote summary the page can render. Every failed inquiry raises
 * exactly one alert + Devin session owned by the pinned on-call owner.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const SENTRY_ENV_SUFFIX = 'E1AEB83C';

let customerSentryScope;
function getCustomerSentryScope() {
  if (customerSentryScope !== undefined) return customerSentryScope;
  const dsn = process.env[`SENTRY_DSN_${SENTRY_ENV_SUFFIX}`];
  if (!dsn || typeof Sentry.NodeClient !== 'function') {
    customerSentryScope = null;
    return customerSentryScope;
  }
  const client = new Sentry.NodeClient({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || 'prod',
    release: process.env.SENTRY_RELEASE,
    transport: Sentry.makeNodeTransport,
    stackParser: Sentry.defaultStackParser,
    integrations: [],
  });
  client.init();
  customerSentryScope = new Sentry.Scope();
  customerSentryScope.setClient(client);
  return customerSentryScope;
}

function captureInquiryError(error, context) {
  const scope = getCustomerSentryScope();
  if (scope) {
    scope.captureException(error, { captureContext: context });
    return;
  }
  Sentry.captureException(error, context);
}

function sentryIssueUrl() {
  const org = process.env[`SENTRY_ORG_SLUG_${SENTRY_ENV_SUFFIX}`] || process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const project = process.env[`SENTRY_PROJECT_ID_${SENTRY_ENV_SUFFIX}`] || process.env.SENTRY_PROJECT_ID || '';
  return `https://${org}.sentry.io/issues/?project=${project}&query=is%3Aunresolved`;
}
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = 'e1aeb83c';
const SERVICE = 'customer-e1aeb83c-subscribe';
const ROUTE = '/api/e1aeb83c/inquiry';

// Server-side owner for every alert and session raised by this vertical.
// Client-supplied identity is kept as diagnostic context only.
const OWNER = Object.freeze({
  slackMemberId: 'U08S7AVJ478',
  devinUserId: 'clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV',
  devinOrgId: 'org-cba5887ae1534949b9696649e27367ad',
});

const OFFERS = Object.freeze({
  'wsj-plus-premier': {
    id: 'wsj-plus-premier',
    name: 'WSJ+ Premier',
    titles: ['wsj', 'marketwatch', 'barrons', 'ibd'],
    pricing: {
      annual: { intro: 119, introTerm: 'year', renewal: 54.99, cycleWeeks: 4 },
      weekly: { intro: 1, introTerm: 'week', renewal: 54.99, cycleWeeks: 4 },
    },
  },
  'wsj-digital': {
    id: 'wsj-digital',
    name: 'WSJ Digital',
    titles: ['wsj'],
    pricing: {
      annual: { intro: 79, introTerm: 'year', renewal: 44.99, cycleWeeks: 4 },
      weekly: { intro: 1, introTerm: 'week', renewal: 44.99, cycleWeeks: 4 },
    },
  },
  'print-and-digital': {
    id: 'print-and-digital',
    name: 'Print & Digital',
    titles: ['wsj', 'print'],
    pricing: {
      annual: { intro: 299, introTerm: 'year', renewal: 89.99, cycleWeeks: 4 },
      weekly: { intro: 2, introTerm: 'week', renewal: 89.99, cycleWeeks: 4 },
    },
  },
});

// Acquisition promotions keyed by campaign code. Eligibility is stored per
// region so the same campaign can run with different intro terms by market.
const PROMOTIONS = Object.freeze({
  '6441GOZMW28': {
    code: '6441GOZMW28',
    campaign: 'WSJ_SCH_GOO_ACQ_NON_AOW_NAP_79D_NAP_WSP',
    eligibility: new Map([
      ['us', { maxIntroCycles: 13, requiresVerification: false, cancelAnytime: true }],
      ['ca', { maxIntroCycles: 13, requiresVerification: false, cancelAnytime: true }],
      ['eu', { maxIntroCycles: 6, requiresVerification: true, cancelAnytime: true }],
    ]),
  },
  STUDENT: {
    code: 'STUDENT',
    campaign: 'WSJ_STUDENT_VERIFIED',
    eligibility: new Map([
      ['us', { maxIntroCycles: 52, requiresVerification: true, cancelAnytime: true }],
    ]),
  },
});

const DEFAULT_TRACKING_CODE = '6441gozmw28';
const DEFAULT_REGION = 'us';

class OfferInquiryError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'OfferInquiryError';
    this.code = code;
    this.details = details;
  }
}

function resolveOffer(offerId) {
  const offer = OFFERS[offerId];
  if (!offer) {
    throw new OfferInquiryError(`Unknown offer: ${offerId}`, 'UNKNOWN_OFFER', { offerId });
  }
  return offer;
}

function buildQuote(offer, billing) {
  const cadence = billing === 'weekly' ? 'weekly' : 'annual';
  const price = offer.pricing[cadence];
  return {
    offerId: offer.id,
    offerName: offer.name,
    billing: cadence,
    introPrice: price.intro,
    introTerm: price.introTerm,
    renewalPrice: price.renewal,
    renewalCycleWeeks: price.cycleWeeks,
    titles: offer.titles.slice(),
  };
}

function resolvePromotion(trackingCode, action) {
  if (action === 'student-rates') return PROMOTIONS.STUDENT;
  const code = String(trackingCode || DEFAULT_TRACKING_CODE).trim().toUpperCase();
  return PROMOTIONS[code] || PROMOTIONS[DEFAULT_TRACKING_CODE.toUpperCase()];
}

function getEligibility(promotion, region) {
  const market = String(region || DEFAULT_REGION).toLowerCase();
  const byRegion = promotion.eligibility;
  return byRegion[market] || byRegion[DEFAULT_REGION];
}

function applyIntroTerms(quote, promotion, eligibility) {
  const introCycles = Math.min(eligibility.maxIntroCycles, 52);
  return {
    ...quote,
    promotionCode: promotion.code,
    campaign: promotion.campaign,
    introCycles,
    requiresVerification: eligibility.requiresVerification,
    cancelAnytime: eligibility.cancelAnytime,
  };
}

function summarizeInquiry(quote, action) {
  const intro = quote.billing === 'annual'
    ? `$${quote.introPrice} for 1 ${quote.introTerm}`
    : `$${quote.introPrice} per ${quote.introTerm}`;
  return {
    offer: quote.offerId,
    offerName: quote.offerName,
    billing: quote.billing,
    action,
    headline: intro,
    renewal: `Then $${quote.renewalPrice.toFixed(2)} every ${quote.renewalCycleWeeks} weeks thereafter`,
    promotion: quote.promotionCode,
    introCycles: quote.introCycles,
    requiresVerification: quote.requiresVerification,
    titles: quote.titles,
  };
}

async function processOfferInquiry(data) {
  const requestId = uuidv4();
  const start = Date.now();
  const action = data.action || 'subscribe';

  logger.info('Processing subscription offer inquiry', {
    requestId,
    customer: CUSTOMER,
    service: SERVICE,
    offer: data.offer,
    billing: data.billing,
    action,
  });

  try {
    const offer = resolveOffer(data.offer || 'wsj-digital');
    const quote = buildQuote(offer, data.billing);
    const promotion = resolvePromotion(data.trackingCode, action);
    const eligibility = getEligibility(promotion, data.region);
    const priced = applyIntroTerms(quote, promotion, eligibility);
    const summary = summarizeInquiry(priced, action);

    const duration = Date.now() - start;
    incrementMetric('e1aeb83c.inquiry.success', 1, [`offer:${summary.offer}`, `billing:${summary.billing}`]);
    recordTiming('e1aeb83c.inquiry.duration', duration, [`offer:${summary.offer}`]);

    return { success: true, requestId, ...summary };
  } catch (error) {
    const duration = Date.now() - start;
    incrementMetric('e1aeb83c.inquiry.error', 1, [`error:${error.name}`]);
    recordTiming('e1aeb83c.inquiry.duration', duration, ['result:error']);

    logger.error('Subscription offer inquiry failed', {
      requestId,
      customer: CUSTOMER,
      service: SERVICE,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      offer: data.offer,
      billing: data.billing,
      action,
    });

    captureInquiryError(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        customer: CUSTOMER,
        alert_path: 'instant',
        offer: data.offer || 'wsj-digital',
        action,
      },
      extra: { requestId, billing: data.billing, viewerUserId: data.viewerUserId },
    });

    if (data.reportErrors !== false) {
      createSessionAndAlert({
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: sentryIssueUrl(),
        culprit: 'app/services/verticals/e1aeb83c.js \u2014 applyIntroTerms',
        errorType: error.name || 'Error',
        errorValue: error.message,
        devinUserId: OWNER.devinUserId,
        devinOrgId: OWNER.devinOrgId,
        slackMemberId: OWNER.slackMemberId,
        service: SERVICE,
        verticalLabel: 'Digital Subscription Offer',
        customer: CUSTOMER,
        tags: [
          { key: 'route', value: ROUTE },
          { key: 'service', value: SERVICE },
          { key: 'alert_path', value: 'instant' },
          { key: 'offer', value: data.offer || 'wsj-digital' },
          { key: 'billing', value: data.billing || 'annual' },
          { key: 'action', value: action },
        ],
        extra: {
          requestId,
          offer: data.offer,
          billing: data.billing,
          action,
          viewerUserId: data.viewerUserId || null,
          viewerOrgId: data.viewerOrgId || null,
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
        logger.error('Failed to create Devin session for offer inquiry error', {
          error: err.message,
          requestId,
          customer: CUSTOMER,
        });
      });
    }

    throw error;
  }
}

module.exports = {
  processOfferInquiry,
  resolveOffer,
  buildQuote,
  resolvePromotion,
  getEligibility,
  applyIntroTerms,
  summarizeInquiry,
  OFFERS,
  OWNER,
};
