const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { resolveProduct } = require('./957da0c9-products');
const { rateTableFor, monthlyPremium } = require('./957da0c9-rates');

const CUSTOMER = '957da0c9';
const ROUTE = '/api/957da0c9/quotes';
const SERVICE = 'homepage-quote-engine';

// Server-side owner for alerts and Devin sessions. Browser-supplied identity
// is recorded as diagnostic context only and never changes ownership.
const OWNER = Object.freeze({
  slackMemberId: 'U08S7AVJ478',
  devinUserId: 'clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV',
  devinOrgId: 'org-2f5155c0633a4a7bb58ef2856b5efa25',
});

const DEFAULT_APPLICANT = Object.freeze({ age: 38, coverage: 500000, tobacco: false, gender: 'female' });

function normalizeApplicant(input) {
  const src = input && typeof input === 'object' ? input : {};
  const age = Number.parseInt(src.age, 10);
  const coverage = Number.parseInt(src.coverage, 10);
  return {
    age: Number.isFinite(age) && age > 0 ? age : DEFAULT_APPLICANT.age,
    coverage: Number.isFinite(coverage) && coverage > 0 ? coverage : DEFAULT_APPLICANT.coverage,
    tobacco: src.tobacco === true || src.tobacco === 'yes',
    gender: typeof src.gender === 'string' && src.gender ? src.gender : DEFAULT_APPLICANT.gender,
  };
}

function buildQuote(product, applicant) {
  const table = rateTableFor(product.ratingBasis);
  const premium = monthlyPremium(table, applicant);
  return {
    quoteId: `GQ-${uuidv4().slice(0, 8).toUpperCase()}`,
    product: product.code,
    productName: product.name,
    termYears: product.defaultTerm,
    monthlyPremium: premium,
    annualPremium: Math.round(premium * 12 * 100) / 100,
    coverage: Math.max(applicant.coverage, table.minCoverage),
    issuedAt: new Date().toISOString(),
  };
}

/**
 * Start a quote from any homepage entry point.
 *
 * @param {object} data - { selection, entryPoint, applicant, report, devinUserId, devinOrgId, devinEmail }
 */
async function startQuote(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const product = resolveProduct(data.selection);
  const applicant = normalizeApplicant(data.applicant);
  const entryPoint = String(data.entryPoint || 'unknown').slice(0, 80);
  const reportFailures = data.report !== false;

  incrementMetric('homepage_quote.started', { route: ROUTE, service: SERVICE, product: product.code, entry_point: entryPoint });
  logger.info('Homepage quote started', { requestId, product: product.code, entryPoint, age: applicant.age, service: SERVICE });

  try {
    const quote = buildQuote(product, applicant);
    const duration = Date.now() - startTime;
    incrementMetric('homepage_quote.success', { route: ROUTE, service: SERVICE, product: product.code });
    recordTiming('homepage_quote.latency', duration, { route: ROUTE });
    logger.info('Homepage quote issued', { requestId, quoteId: quote.quoteId, product: product.code, durationMs: duration });
    return { requestId, ...quote };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('homepage_quote.failure', { route: ROUTE, service: SERVICE, product: product.code, errorClass: error.name });
    recordTiming('homepage_quote.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Homepage quote failed', {
      requestId, product: product.code, ratingBasis: product.ratingBasis, entryPoint, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    error.requestId = requestId;
    if (!error.statusCode) error.statusCode = 500;

    if (!reportFailures) {
      logger.info('Homepage quote failure reporting disabled for this request', { requestId });
      throw error;
    }

    const context = {
      requestId,
      product: product.code,
      ratingBasis: product.ratingBasis,
      entryPoint,
      applicantAge: applicant.age,
      coverage: applicant.coverage,
      tobacco: applicant.tobacco,
      requestIdentity: { devinUserId: data.devinUserId || '', devinOrgId: data.devinOrgId || '', devinEmail: data.devinEmail || '' },
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: CUSTOMER, product: product.code, alert_path: 'instant',
      },
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/957da0c9.js — startQuote',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: OWNER.devinUserId,
      devinOrgId: OWNER.devinOrgId,
      customer: CUSTOMER,
      slackMemberId: OWNER.slackMemberId,
      slackMemberIdFallback: OWNER.slackMemberId,
      service: SERVICE,
      verticalLabel: 'Guardian Life — Homepage Quote Flow',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'product', value: product.code },
        { key: 'rating_basis', value: product.ratingBasis },
        { key: 'entry_point', value: entryPoint },
      ],
      extra: {
        ...context,
        promptContext: 'Every call to action on the guardianlife.com homepage (Get a quote, the I am... segments, product cards, Learn more links) starts a quote and every quote fails with HTTP 500 before a premium is calculated, so no visitor can get a quote or reach a product page.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@3.8.1`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'When you fix this, add a regression test that prices one quote for every product in the catalog, and record a browser video of /957da0c9 showing Get a quote succeeding.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = { startQuote, buildQuote, normalizeApplicant, OWNER };
