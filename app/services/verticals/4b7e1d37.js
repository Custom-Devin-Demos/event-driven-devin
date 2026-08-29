const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Deposit products a visitor can start an online application for from the
 * personal banking homepage.
 */
const PRODUCT_CATALOG = [
  {
    productCode: 'vw-checking',
    name: 'Virtual Wallet Checking Pro',
    category: 'checking',
    monthlyFee: 7.00,
    feeWaiverMinBalance: 500,
    enrollmentChannel: 'online',
  },
  {
    productCode: 'std-checking',
    name: 'Standard Checking',
    category: 'checking',
    monthlyFee: 5.00,
    feeWaiverMinBalance: 300,
    enrollmentChannel: 'branch',
  },
];

/**
 * Enrollment channel configuration — drives identity verification,
 * funding options and debit card issuance for new accounts.
 */
const ENROLLMENT_CHANNELS = {
  online: {
    label: 'Online application',
    identityCheck: 'knowledge-based-verification',
    fundingOptions: ['external_transfer', 'debit_card'],
    cardIssuance: { network: 'visa-debit', arrivalDays: 7 },
  },
  branch: {
    label: 'In-branch appointment',
    identityCheck: 'document-review',
    fundingOptions: ['cash', 'check', 'external_transfer'],
    cardIssuance: { network: 'branch-print', arrivalDays: 0 },
  },
};

function resolveProduct(productCode) {
  return PRODUCT_CATALOG.find((p) => p.productCode === productCode) || PRODUCT_CATALOG[0];
}

/**
 * Normalize the raw inquiry into the shape the onboarding planner consumes.
 */
function normalizeInquiry(data, product) {
  return {
    productCode: product.productCode,
    zipCode: String(data.zipCode || '15222').trim(),
    channel: product.enrollmentChannel,
    requestedAt: new Date().toISOString(),
  };
}

/**
 * Build the onboarding plan for the application: identity verification,
 * funding options and the debit card issuance path for the channel.
 */
function buildOnboardingPlan(inquiry, product) {
  const channel = ENROLLMENT_CHANNELS[inquiry.channel];

  const plan = {
    productCode: product.productCode,
    channelLabel: channel.label,
    identityCheck: channel.identityCheck,
    fundingOptions: channel.fundingOptions,
    cardIssuance: channel.cardIssuance || null,
  };

  return plan;
}

/**
 * Assemble the confirmation summary shown to the applicant.
 */
function summarizeInquiry(referenceNumber, inquiry, plan, product) {
  return {
    referenceNumber,
    status: 'received',
    product: product.name,
    category: product.category,
    monthlyFee: product.monthlyFee,
    feeWaiverMinBalance: product.feeWaiverMinBalance,
    channel: plan.channelLabel,
    identityCheck: plan.identityCheck,
    fundingOptions: plan.fundingOptions,
    cardNetwork: plan.cardIssuance ? plan.cardIssuance.network : null,
    cardArrivalDays: plan.cardIssuance ? plan.cardIssuance.arrivalDays : null,
    zipCode: inquiry.zipCode,
  };
}

/**
 * Processes an online account-opening inquiry from the homepage.
 */
async function processAccountInquiry(data) {
  const startTime = Date.now();
  const referenceNumber = `AO-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Processing account opening inquiry', {
    referenceNumber,
    productCode: data.productCode,
    service: 'customer-4b7e1d37-account-inquiry',
    route: '/api/4b7e1d37/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 120));

    const product = resolveProduct(data.productCode);
    const inquiry = normalizeInquiry(data, product);
    const plan = buildOnboardingPlan(inquiry, product);
    const summary = summarizeInquiry(referenceNumber, inquiry, plan, product);

    const duration = Date.now() - startTime;

    incrementMetric('account_inquiry.success', {
      route: '/api/4b7e1d37/inquiry',
      productCode: product.productCode,
    });
    recordTiming('account_inquiry.latency', duration, {
      route: '/api/4b7e1d37/inquiry',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('account_inquiry.failure', {
      route: '/api/4b7e1d37/inquiry',
      errorClass: error.name,
      productCode: data.productCode,
    });
    recordTiming('account_inquiry.latency', duration, {
      route: '/api/4b7e1d37/inquiry',
      error: 'true',
    });

    logger.error('Account opening inquiry failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      productCode: data.productCode,
      service: 'customer-4b7e1d37-account-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/4b7e1d37/inquiry',
        service: 'customer-4b7e1d37-account-inquiry',
        productCode: data.productCode,
      },
      extra: {
        referenceNumber,
        zipCode: data.zipCode,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4b7e1d37.js \u2014 summarizeInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-4b7e1d37-account-inquiry',
      verticalLabel: 'Personal Banking Account Opening',
      customer: '4b7e1d37',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/4b7e1d37/inquiry' },
        { key: 'service', value: 'customer-4b7e1d37-account-inquiry' },
        { key: 'productCode', value: data.productCode },
      ],
      extra: {
        referenceNumber,
        zipCode: data.zipCode,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-4b7e1d37-account-inquiry@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for account inquiry error', {
        error: err.message,
        referenceNumber,
      });
    });

    throw error;
  }
}

module.exports = { processAccountInquiry, PRODUCT_CATALOG, ENROLLMENT_CHANNELS };
