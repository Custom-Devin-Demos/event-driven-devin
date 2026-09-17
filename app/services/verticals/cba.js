const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ACCOUNTS = {
  '062-000 10345678': {
    accountNumber: '062-000 10345678',
    productCode: 'smart_access',
    productLabel: 'Smart Access',
    balance: 24850.00,
    dailyLimit: 20000,
    holderName: 'Alice Chen',
  },
  '062-000 10345691': {
    accountNumber: '062-000 10345691',
    productCode: 'netbank_saver',
    productLabel: 'NetBank Saver',
    balance: 142300.00,
    dailyLimit: 5000,
    holderName: 'Alice Chen',
  },
  '062-000 10988204': {
    accountNumber: '062-000 10988204',
    productCode: 'business_transaction',
    productLabel: 'Business Transaction Account',
    balance: 68420.55,
    dailyLimit: 50000,
    holderName: 'Chen Design Studio Pty Ltd',
  },
};

/**
 * NPP addressing profiles, keyed by the PayID type the payee was entered as.
 * Each profile names the directory service NetBank resolves the PayID against
 * before the payment is handed to Osko.
 */
const NPP_ADDRESSING_PROFILES = {
  email: {
    label: 'Email PayID',
    directoryService: 'NPP Addressing Service',
    resolutionTimeoutMs: 3000,
    oskoEligible: true,
    confirmationRequired: false,
  },
  mobile: {
    label: 'Mobile PayID',
    directoryService: 'NPP Addressing Service',
    resolutionTimeoutMs: 3000,
    oskoEligible: true,
    confirmationRequired: false,
  },
  // abn — business PayIDs shipped with the 2026 NetBank payee refresh;
  // addressing profile registration pending
};

const OSKO_ENABLED_BSBS = ['062-000', '062-001', '063-000', '083-004', '013-006'];

const SETTLEMENT_RAILS = {
  osko: { name: 'Osko', clearingWindowMinutes: 1, cutOffAest: null },
  direct_entry: { name: 'Direct Entry', clearingWindowMinutes: 1440, cutOffAest: '16:00' },
  bpay: { name: 'BPAY', clearingWindowMinutes: 720, cutOffAest: '18:00' },
};

const CBA_SLACK_MEMBER_ID = process.env.CBA_SLACK_MEMBER_ID || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved directoryService';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the CommBank NetBank payment failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/nab/payment and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/cba/payment, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the CommBank NetBank "Pay anyone" page at app/public/verticals/cba.html (page route GET /cba), whose "Pay now" action posts to POST /api/cba/payment in app/routes/verticals/cba.js. The payment pipeline lives in app/services/verticals/cba.js: submitPayment -> settlePayment -> resolveAddressingProfile. Start at resolveAddressingProfile: it looks up NPP_ADDRESSING_PROFILES by the PayID type carried on the payee, and business (ABN) PayIDs shipped with the 2026 NetBank payee refresh without a registered addressing profile, so the lookup returns undefined and settlePayment dereferences it while resolving the PayID against the NPP addressing service. Register the missing PayID type's addressing profile and make an unknown PayID type fail as a handled payments error routed to the payments operations queue instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing an ABN PayID payment from account 062-000 10345678 to /api/cba/payment, which must return a successful payment receipt, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /cba page in a real browser, submit the pre-filled ABN PayID payment from the Smart Access account, and record your screen for the whole submission so the recording shows the form, the click, and the successful payment receipt that replaces the previous TypeError panel. Attach a screenshot of that successful receipt and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_PAYMENT';
  error.statusCode = 400;
  return error;
}

function resolveAddressingProfile(payee) {
  return NPP_ADDRESSING_PROFILES[payee.payIdType];
}

function selectSettlementRail(payment, payee) {
  if (payment.paymentMethod === 'bpay') return SETTLEMENT_RAILS.bpay;
  if (payment.paymentMethod === 'payid') return SETTLEMENT_RAILS.osko;
  return OSKO_ENABLED_BSBS.includes(payee.bsb) ? SETTLEMENT_RAILS.osko : SETTLEMENT_RAILS.direct_entry;
}

function estimateArrival(rail) {
  const arrival = new Date();
  arrival.setMinutes(arrival.getMinutes() + rail.clearingWindowMinutes);
  return arrival.toISOString();
}

function settlePayment(account, payment, payee) {
  if (payment.amount > account.dailyLimit) {
    throw validationError(`Payment amount exceeds the daily payment limit of ${account.dailyLimit}`);
  }

  const rail = selectSettlementRail(payment, payee);
  let resolvedPayee = payee.name;

  if (payment.paymentMethod === 'payid') {
    const profile = resolveAddressingProfile(payee);
    logger.info('Resolving PayID against the NPP addressing service', {
      payIdType: payee.payIdType,
      directoryService: profile.directoryService,
      route: '/api/cba/payment',
    });
    resolvedPayee = `${payee.name} (${profile.label})`;
  }

  return {
    rail: rail.name,
    resolvedPayee,
    transferFee: 0,
    totalDebited: payment.amount,
    estimatedArrival: estimateArrival(rail),
    remainingDailyLimit: account.dailyLimit - payment.amount,
  };
}

async function submitPayment(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const receiptNumber = `NB${Math.floor(Math.random() * 1000000000).toString().padStart(9, '0')}`;
  const account = ACCOUNTS[data.fromAccount];
  const payment = {
    paymentMethod: data.paymentMethod,
    amount: data.amount,
    description: data.description,
  };
  const payee = {
    name: data.payeeName,
    bsb: data.payeeBsb,
    account: data.payeeAccount,
    payId: data.payId,
    payIdType: data.payIdType,
    billerCode: data.billerCode,
    billerReference: data.billerReference,
  };

  if (!account) {
    throw validationError(`Unknown account number: ${data.fromAccount || '(none)'}`);
  }
  if (!(data.amount > 0)) {
    throw validationError('Payment amount must be greater than zero');
  }
  if (data.amount > account.balance) {
    throw validationError(`Payment amount exceeds the available balance of ${account.balance.toFixed(2)}`);
  }
  if (!['pay_anyone', 'payid', 'bpay'].includes(data.paymentMethod)) {
    throw validationError('Unsupported payment method');
  }
  if (!data.payeeName || !String(data.payeeName).trim()) {
    throw validationError('Payee name is required');
  }
  if (data.paymentMethod === 'pay_anyone') {
    if (!data.payeeBsb || !String(data.payeeBsb).trim()) {
      throw validationError('Payee BSB is required');
    }
    if (!data.payeeAccount || !String(data.payeeAccount).trim()) {
      throw validationError('Payee account number is required');
    }
  } else if (data.paymentMethod === 'payid') {
    if (!data.payId || !String(data.payId).trim()) {
      throw validationError('PayID is required');
    }
    if (!data.payIdType || !String(data.payIdType).trim()) {
      throw validationError('PayID type is required');
    }
  } else if (!data.billerCode || !String(data.billerCode).trim()) {
    throw validationError('Biller code is required');
  } else if (!data.billerReference || !String(data.billerReference).trim()) {
    throw validationError('BPAY reference is required');
  }

  logger.info('Submitting NetBank payment', {
    requestId,
    receiptNumber,
    fromAccount: data.fromAccount,
    paymentMethod: data.paymentMethod,
    payIdType: data.payIdType,
    amount: data.amount,
    service: 'customer-cba-payment',
    route: '/api/cba/payment',
  });

  try {
    const settlement = settlePayment(account, payment, payee);
    const duration = Date.now() - startTime;

    incrementMetric('cba_payment.success', {
      route: '/api/cba/payment',
      productCode: account.productCode,
      paymentMethod: data.paymentMethod,
    });
    recordTiming('cba_payment.latency', duration, {
      route: '/api/cba/payment',
    });

    return {
      success: true,
      receiptNumber,
      fromAccount: data.fromAccount,
      productLabel: account.productLabel,
      payeeName: settlement.resolvedPayee,
      amount: data.amount,
      transferFee: settlement.transferFee,
      totalDebited: settlement.totalDebited,
      settlementRail: settlement.rail,
      estimatedArrival: settlement.estimatedArrival,
      remainingDailyLimit: settlement.remainingDailyLimit,
      requestId,
    };
  } catch (error) {
    if (error.name === 'ValidationError') {
      throw error;
    }

    const duration = Date.now() - startTime;

    incrementMetric('cba_payment.failure', {
      route: '/api/cba/payment',
      errorClass: error.name,
      productCode: account.productCode,
      paymentMethod: data.paymentMethod,
    });
    recordTiming('cba_payment.latency', duration, {
      route: '/api/cba/payment',
      error: 'true',
    });

    logger.error('NetBank payment submission failed', {
      requestId,
      receiptNumber,
      fromAccount: data.fromAccount,
      paymentMethod: data.paymentMethod,
      payIdType: data.payIdType,
      amount: data.amount,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-cba-payment',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/cba/payment',
        service: 'customer-cba-payment',
        productCode: account.productCode,
        paymentMethod: data.paymentMethod,
        payIdType: data.payIdType || 'none',
      },
      extra: {
        requestId,
        receiptNumber,
        fromAccount: data.fromAccount,
        productCode: account.productCode,
        paymentMethod: data.paymentMethod,
        payIdType: data.payIdType,
        amount: data.amount,
        payeeName: data.payeeName,
        payeeBsb: data.payeeBsb,
        payeeAccount: data.payeeAccount,
        payId: data.payId,
        billerCode: data.billerCode,
        billerReference: data.billerReference,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/cba.js — settlePayment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-cba-payment',
      verticalLabel: 'CommBank NetBank — Pay anyone',
      customer: 'cba',
      slackMemberId: data.devinEmail ? '' : CBA_SLACK_MEMBER_ID,
      slackMemberIdFallback: CBA_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/cba/payment' },
        { key: 'service', value: 'customer-cba-payment' },
        { key: 'productCode', value: account.productCode },
        { key: 'paymentMethod', value: data.paymentMethod },
        { key: 'payIdType', value: data.payIdType || 'none' },
      ],
      extra: {
        requestId,
        receiptNumber,
        fromAccount: data.fromAccount,
        productCode: account.productCode,
        paymentMethod: data.paymentMethod,
        payIdType: data.payIdType,
        amount: data.amount,
        payeeName: data.payeeName,
        payeeBsb: data.payeeBsb,
        payeeAccount: data.payeeAccount,
        payId: data.payId,
        billerCode: data.billerCode,
        billerReference: data.billerReference,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-cba-payment@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for NetBank payment error', {
        requestId,
        receiptNumber,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  submitPayment,
  settlePayment,
  resolveAddressingProfile,
  selectSettlementRail,
  estimateArrival,
  ACCOUNTS,
  NPP_ADDRESSING_PROFILES,
  SETTLEMENT_RAILS,
  OSKO_ENABLED_BSBS,
  REMEDIATION_DIRECTIVE,
};
