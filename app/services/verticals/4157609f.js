const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { lookupPayId } = require('./4157609f-directory');

const ROUTE = '/api/4157609f/payments';
const SERVICE = '4157609f-api';
const RELEASE = 'npp-payments-gateway@2.31.0';
const PREVIOUS_RELEASE = 'npp-payments-gateway@2.30.0';
const SLACK_MEMBER_ID = 'U0BDHHQUM24';
const TIMEZONE = 'Australia/Sydney';
const REGION = 'ap-southeast-2';

const PAYER_ACCOUNTS = {
  '062-000 10345678': {
    account: '062-000 10345678',
    product: 'Smart Access',
    holder: 'Alice Chen',
    balanceCents: 2485000,
    dailyLimitCents: 2000000,
  },
  '062-000 10988204': {
    account: '062-000 10988204',
    product: 'Business Transaction Account',
    holder: 'Chen Design Studio Pty Ltd',
    balanceCents: 6842055,
    dailyLimitCents: 5000000,
  },
};

const PAYID_TYPES = {
  email: { label: 'Email PayID', oskoEligible: true },
  phone: { label: 'Mobile PayID', oskoEligible: true },
  abn: { label: 'ABN PayID', oskoEligible: true },
};

const PAYEE_NAME_FIELD = {
  email: 'displayName',
  phone: 'displayName',
};

const DEFAULT_PAYMENT = {
  fromAccount: '062-000 10988204',
  payIdType: 'abn',
  payId: '51 824 753 556',
  amountCents: 128450,
  description: 'INV-20418 freight',
  currency: 'AUD',
};

const DEPLOYMENTS = [
  {
    release: PREVIOUS_RELEASE,
    deployedAt: '2026-09-18T11:52:00+10:00',
    errorRatePct: 0.3,
  },
  {
    release: RELEASE,
    deployedAt: '2026-09-25T22:31:00+10:00',
    errorRatePct: 8.1,
    changes: [
      'PayID resolution: read payee display name from directory record',
      'Osko eligibility now sourced from participant capability flags',
    ],
  },
];

let PAYMENTS = [];
let gatewayState = { status: 'healthy', failedCount: 0, lastFailureAt: null };

function normalisePayId(record, payIdType) {
  return {
    payIdType,
    payId: payIdType === 'phone' ? record.payId.replace(/\s+/g, '') : record.payId,
    payeeName: record[PAYEE_NAME_FIELD[payIdType]],
    accountName: record.accountName,
    bsb: record.bsb,
    accountNumber: record.accountNumber,
    participant: record.participant,
  };
}

function buildCreditTransfer(payment, resolved, requestId) {
  return {
    messageId: `NPP-${requestId.slice(0, 8).toUpperCase()}`,
    amountCents: payment.amountCents,
    currency: payment.currency,
    debtorAccount: payment.fromAccount,
    creditorName: resolved.payeeName.toUpperCase(),
    creditorBsb: resolved.bsb,
    creditorAccount: resolved.accountNumber,
    remittance: payment.description,
    osko: PAYID_TYPES[payment.payIdType].oskoEligible,
    settlement: 'FSS',
    submittedAt: new Date().toISOString(),
  };
}

function checkLimits(payment, account) {
  if (!Number.isInteger(payment.amountCents) || payment.amountCents <= 0) {
    throw new Error(`Invalid amountCents: ${payment.amountCents}`);
  }
  if (payment.amountCents > account.dailyLimitCents) {
    throw new Error(`Amount exceeds daily payment limit of ${account.dailyLimitCents / 100} for ${account.account}`);
  }
  if (payment.amountCents > account.balanceCents) {
    throw new Error(`Insufficient available balance in ${account.account}`);
  }
}

async function initiatePayment(data) {
  const requestId = uuidv4();
  const payment = { ...DEFAULT_PAYMENT };
  ['fromAccount', 'payIdType', 'payId', 'amountCents', 'description'].forEach((field) => {
    if (data && data[field] !== undefined) payment[field] = data[field];
  });

  logger.info('NPP payment initiated', {
    requestId,
    payIdType: payment.payIdType,
    release: RELEASE,
    region: REGION,
    service: SERVICE,
  });
  const metricTags = [`payid_type:${payment.payIdType}`, `release:${RELEASE}`];
  incrementMetric('npp.payments.initiated', metricTags);

  const startTime = Date.now();

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const account = PAYER_ACCOUNTS[payment.fromAccount];
    if (!account) {
      throw new Error(`Payer account not registered with gateway: ${payment.fromAccount}`);
    }
    checkLimits(payment, account);
    const record = lookupPayId(payment.payIdType, payment.payId);
    const resolved = normalisePayId(record, payment.payIdType);
    const transfer = buildCreditTransfer(payment, resolved, requestId);

    const latencyMs = Date.now() - startTime;
    const result = {
      requestId,
      status: 'settled',
      release: RELEASE,
      region: REGION,
      timezone: TIMEZONE,
      payment,
      resolved,
      transfer,
      latencyMs,
    };
    PAYMENTS.push(result);
    if (PAYMENTS.length > 200) PAYMENTS.shift();
    incrementMetric('npp.payments.settled', metricTags);
    recordTiming('npp.payments.latency', latencyMs, metricTags);
    logger.info('NPP payment settled', {
      requestId,
      payIdType: payment.payIdType,
      latencyMs,
      service: SERVICE,
    });
    return result;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    gatewayState.status = 'degraded';
    gatewayState.failedCount += 1;
    gatewayState.lastFailureAt = new Date().toISOString();
    incrementMetric('npp.payments.failed', [...metricTags, `error_type:${error.name}`]);
    recordTiming('npp.payments.latency', latencyMs, metricTags);
    logger.error('NPP payment failed', {
      requestId,
      payIdType: payment.payIdType,
      payId: payment.payId,
      amountCents: payment.amountCents,
      error: error.message,
      errorClass: error.name,
      latencyMs,
      service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        alert_path: 'instant',
        payid_type: payment.payIdType,
        release: RELEASE,
      },
      extra: {
        requestId,
        payIdType: payment.payIdType,
        payId: payment.payId,
        amountCents: payment.amountCents,
      },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4157609f.js — initiatePayment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'CommBank NPP Payments Gateway — PayID payment',
      slackMemberId: SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'payid_type', value: payment.payIdType },
        { key: 'release', value: RELEASE },
        { key: 'previous_release', value: PREVIOUS_RELEASE },
        { key: 'region', value: REGION },
        { key: 'monitor', value: 'npp.payments.error_rate > 2% for 5m' },
        { key: 'channel', value: '#inc-npp-payments' },
      ],
      extra: {
        requestId,
        payIdType: payment.payIdType,
        payId: payment.payId,
        amountCents: payment.amountCents,
        currency: 'AUD',
        fromAccount: payment.fromAccount,
        release: RELEASE,
        previousRelease: PREVIOUS_RELEASE,
        deployedAt: DEPLOYMENTS.find((deployment) => deployment.release === RELEASE).deployedAt,
        region: REGION,
        timezone: TIMEZONE,
        errorRatePct: 8.1,
        promptContext: 'Datadog monitor `npp.payments.error_rate > 2% for 5m` fired at 22:40 AEST, nine minutes after npp-payments-gateway@2.31.0 was deployed to ap-southeast-2. Payments addressed to email and mobile PayIDs still settle; every payment addressed to an ABN (business) PayID fails with this TypeError, about 8% of Friday-night NPP volume. NPP is a 24x7 real-time scheme and CPS 230 treats payments as a critical operation, so the on-call team\'s first question is whether to roll back to 2.30.0 before fixing forward.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || RELEASE,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: 'npp.payments.error_rate > 2% for 5m',
      promptAppendix: 'Recommend rollback to npp-payments-gateway@2.30.0 as the immediate mitigation, then fix forward. The fix must make ABN PayID payments settle with the creditor name taken from the directory record, and must handle ABNs that arrive with spaces. Add a regression test that initiates a payment to each PayID type (email, mobile, ABN) and asserts every one settles with a non-empty creditorName and an 11-digit ABN with no spaces where applicable. Draft an incident timeline for the post-incident review. Verify in the browser on /4157609f.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from NPP payment error', { error: err.message });
    });
    throw error;
  }
}

function getOverview() {
  return {
    release: RELEASE,
    previousRelease: PREVIOUS_RELEASE,
    region: REGION,
    timezone: TIMEZONE,
    gateway: gatewayState,
    deployments: DEPLOYMENTS,
    accounts: Object.values(PAYER_ACCOUNTS),
    payIdTypes: PAYID_TYPES,
    defaultPayment: DEFAULT_PAYMENT,
    recentPayments: PAYMENTS.slice(-10),
  };
}

function resetGateway() {
  PAYMENTS = [];
  gatewayState = { status: 'healthy', failedCount: 0, lastFailureAt: null };
  logger.info('NPP payments gateway reset', { service: SERVICE, release: RELEASE });
  return { status: 'reset', gateway: gatewayState, release: RELEASE };
}

module.exports = {
  initiatePayment,
  resetGateway,
  getOverview,
  normalisePayId,
  buildCreditTransfer,
  PAYER_ACCOUNTS,
  PAYID_TYPES,
  DEFAULT_PAYMENT,
  DEPLOYMENTS,
};
