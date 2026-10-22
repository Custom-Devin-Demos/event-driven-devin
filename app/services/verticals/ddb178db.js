const { URLSearchParams } = require('url');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listProducts, getProduct } = require('./ddb178db-catalog');
const { pricingFor, disclosureFor } = require('./ddb178db-pricing');

const SLACK_MEMBER_ID = process.env.CDDB178DB_SLACK_MEMBER_ID || '';
const SERVICE = 'card-acquisition-web';
const ROUTE = '/api/ddb178db/card-offers/:productId/applications';
const APPLY_URL = 'https://secure.bankofamerica.com/ogateway/public/apply-now-services/iaoconsumer/rest/public/usa/initialize/cc/v1';

const applications = new Map();

function fmtApr(apr) {
  return `${apr.min.toFixed(2)}%–${apr.max.toFixed(2)}% variable APR`;
}

function buildTerms(product, schedule) {
  const purchaseApr = fmtApr(schedule.purchaseApr);
  const intro = schedule.introPurchaseCycles > 0
    ? `0% intro APR for ${schedule.introPurchaseCycles} billing cycles for purchases`
    : 'No intro APR';
  return {
    purchaseApr,
    intro,
    introPurchaseCycles: schedule.introPurchaseCycles,
    balanceTransferFee: schedule.balanceTransferFee,
    foreignTransactionFee: `${schedule.foreignTransactionFee}%`,
    cashAdvanceApr: `${schedule.cashAdvanceApr.toFixed(2)}% variable APR`,
    bonus: product.bonus,
  };
}

function buildDisclosure(product, terms) {
  return disclosureFor(product)
    .replace('{{name}}', product.name)
    .replace('{{apr}}', terms.purchaseApr)
    .replace('{{intro}}', `${terms.intro}.`);
}

function buildApplyUrl(product, applicationId) {
  const params = new URLSearchParams({
    requesttype: 'usa', campaignId: product.campaignId, productoffercode: product.productId, ref: applicationId,
  });
  return `${APPLY_URL}?${params}`;
}

async function startApplication(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const product = getProduct(data.productId);
  if (!product) {
    const err = new Error(`Unknown card product: ${data.productId}`);
    err.statusCode = 404;
    err.code = 'CARD_PRODUCT_NOT_FOUND';
    err.requestId = requestId;
    throw err;
  }

  logger.info('Card application started', { requestId, productId: product.productId, campaignId: product.campaignId, service: SERVICE });

  try {
    const schedule = pricingFor(product);
    const terms = buildTerms(product, schedule);
    const disclosure = buildDisclosure(product, terms);
    const applicationId = `CC-${requestId.slice(0, 8).toUpperCase()}`;

    const duration = Date.now() - startTime;
    incrementMetric('card_application.started', { route: ROUTE, service: SERVICE, product: product.productId });
    recordTiming('card_application.latency', duration, { route: ROUTE });
    logger.info('Card application prefill ready', { requestId, applicationId, productId: product.productId, durationMs: duration });

    const result = {
      applicationId,
      product: { productId: product.productId, name: product.name },
      terms,
      disclosure,
      continueUrl: buildApplyUrl(product, applicationId),
    };
    applications.set(applicationId, result);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('card_application.failure', {
      route: ROUTE, service: SERVICE, product: product.productId, errorClass: error.name,
    });
    recordTiming('card_application.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Card application failed', {
      requestId, productId: product.productId, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    error.requestId = requestId;
    if (!error.statusCode) error.statusCode = 500;

    const context = {
      requestId,
      productId: product.productId,
      productName: product.name,
      network: product.network,
      tier: product.tier,
      campaignId: product.campaignId,
      bonus: product.bonus,
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: 'ddb178db', product: product.productId, alert_path: 'instant',
      },
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ddb178db.js — startApplication',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: 'ddb178db',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Bank of America — Credit Card Offers',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'product', value: product.productId },
        { key: 'network', value: product.network },
        { key: 'campaign_id', value: product.campaignId },
      ],
      extra: {
        ...context,
        promptContext: 'Visitors on the Bank of America homepage cannot start a credit card application: every card offer button in the masthead fails with HTTP 500 before the applicant reaches the secure application, so the acquisition funnel is down for all four featured cards.',
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
      promptAppendix: 'When you fix this, add regression tests that start an application for every product in the card catalog, and record a browser video of /ddb178db showing a masthead card offer starting its application successfully.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = { listProducts, getProduct, startApplication };
