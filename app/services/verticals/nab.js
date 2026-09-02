const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ACCOUNTS = {
  '082-001 40817266': {
    accountNumber: '082-001 40817266',
    productCode: 'everyday_global_2026',
    productLabel: 'NAB Everyday Global (2026)',
    balance: 6482.15,
    holderName: 'Isabella Nguyen',
  },
  '082-001 14872931': {
    accountNumber: '082-001 14872931',
    productCode: 'classic_banking',
    productLabel: 'NAB Classic Banking',
    balance: 3210.40,
    holderName: 'Isabella Nguyen',
  },
  '082-001 22059347': {
    accountNumber: '082-001 22059347',
    productCode: 'isaver',
    productLabel: 'NAB iSaver',
    balance: 18750.00,
    holderName: 'Isabella Nguyen',
  },
};

const PAYMENT_LIMIT_SCHEDULES = {
  classic_banking: {
    label: 'NAB Classic Banking',
    dailyLimit: 20000,
    oskoEligible: true,
    transferFee: 0,
    holdHours: 0,
    fraudQueue: 'payments-everyday',
  },
  isaver: {
    label: 'NAB iSaver',
    dailyLimit: 5000,
    oskoEligible: false,
    transferFee: 0,
    holdHours: 24,
    fraudQueue: 'payments-savings',
  },
  // everyday_global_2026 ships with the 2026 everyday-banking refresh; schedule registration pending
};

const NAB_SLACK_MEMBER_ID = process.env.NAB_SLACK_MEMBER_ID || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved dailyLimit';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the NAB payment failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/insurance/claim and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/nab/payment, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the NAB Internet Banking "Pay someone" page at app/public/verticals/nab.html (page route GET /nab), whose "Pay now" action posts to POST /api/nab/payment in app/routes/verticals/nab.js. The payment settlement pipeline lives in app/services/verticals/nab.js: submitPayment -> calculatePaymentSettlement -> resolvePaymentLimitSchedule. Start at resolvePaymentLimitSchedule: it looks up PAYMENT_LIMIT_SCHEDULES by the product code carried on the source account, and the everyday_global_2026 product shipped with the 2026 everyday-banking refresh without a registered payment limit schedule, so the lookup returns undefined and calculatePaymentSettlement dereferences it while checking the daily limit. Register the missing product's payment limit schedule and make the lookup fail as a handled payments error routed to the payments operations queue instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing a Pay Anyone payment from account 082-001 40817266 to /api/nab/payment, which must return a successful payment receipt, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /nab page in a real browser, submit the pre-filled payment from the NAB Everyday Global account, and record your screen for the whole submission so the recording shows the form, the click, and the successful payment receipt that replaces the previous TypeError panel. Attach a screenshot of that successful receipt and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function resolvePaymentLimitSchedule(account) {
  return PAYMENT_LIMIT_SCHEDULES[account.productCode];
}

function selectSettlementRail(schedule, payee) {
  return schedule.oskoEligible && payee.paymentMethod !== 'bpay' ? 'Osko' : 'Direct Entry';
}

function calculateTransferFee(schedule, payment) {
  return schedule.transferFee * (payment.amount > 0 ? 1 : 0);
}

function estimateArrival(schedule, rail) {
  const arrival = new Date();
  const holdHours = rail === 'Osko' ? 0 : schedule.holdHours;
  arrival.setHours(arrival.getHours() + holdHours);
  return arrival.toISOString();
}

function calculatePaymentSettlement(account, payment, payee) {
  const schedule = resolvePaymentLimitSchedule(account);

  if (payment.amount > schedule.dailyLimit) {
    throw validationError(`Payment amount exceeds the daily limit of ${schedule.dailyLimit}`);
  }

  const settlementRail = selectSettlementRail(schedule, payee);
  const transferFee = calculateTransferFee(schedule, payment);
  const estimatedArrival = estimateArrival(schedule, settlementRail);

  return {
    schedule,
    transferFee,
    totalDebited: payment.amount + transferFee,
    settlementRail,
    estimatedArrival,
    remainingDailyLimit: schedule.dailyLimit - payment.amount,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_PAYMENT';
  error.statusCode = 400;
  return error;
}

async function submitPayment(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const receiptNumber = `NAB-${Math.floor(Math.random() * 1000000000).toString().padStart(9, '0')}`;
  const account = ACCOUNTS[data.fromAccount];
  const payment = {
    paymentMethod: data.paymentMethod,
    amount: data.amount,
    description: data.description,
  };
  const payee = {
    paymentMethod: data.paymentMethod,
    name: data.payeeName,
    bsb: data.payeeBsb,
    account: data.payeeAccount,
  };

  if (!account) {
    throw validationError(`Unknown account number: ${data.fromAccount || '(none)'}`);
  }
  if (!(data.amount > 0)) {
    throw validationError('Payment amount must be greater than zero');
  }
  if (!data.payeeName || !String(data.payeeName).trim()) {
    throw validationError('Payee name is required');
  }
  if (!data.payeeBsb || !String(data.payeeBsb).trim()) {
    throw validationError('Payee BSB is required');
  }
  if (!data.payeeAccount || !String(data.payeeAccount).trim()) {
    throw validationError('Payee account is required');
  }

  logger.info('Submitting NAB payment', {
    requestId,
    receiptNumber,
    fromAccount: data.fromAccount,
    paymentMethod: data.paymentMethod,
    amount: data.amount,
    service: 'customer-nab-payment',
    route: '/api/nab/payment',
  });

  try {
    const settlement = calculatePaymentSettlement(account, payment, payee);
    const duration = Date.now() - startTime;

    incrementMetric('nab_payment.success', {
      route: '/api/nab/payment',
      productCode: account.productCode,
      paymentMethod: data.paymentMethod,
    });
    recordTiming('nab_payment.latency', duration, {
      route: '/api/nab/payment',
    });

    return {
      success: true,
      receiptNumber,
      fromAccount: data.fromAccount,
      productLabel: account.productLabel,
      payeeName: data.payeeName,
      amount: data.amount,
      transferFee: settlement.transferFee,
      totalDebited: settlement.totalDebited,
      settlementRail: settlement.settlementRail,
      estimatedArrival: settlement.estimatedArrival,
      remainingDailyLimit: settlement.remainingDailyLimit,
      requestId,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('nab_payment.failure', {
      route: '/api/nab/payment',
      errorClass: error.name,
      productCode: account.productCode,
      paymentMethod: data.paymentMethod,
    });
    recordTiming('nab_payment.latency', duration, {
      route: '/api/nab/payment',
      error: 'true',
    });

    logger.error('NAB payment submission failed', {
      requestId,
      receiptNumber,
      fromAccount: data.fromAccount,
      paymentMethod: data.paymentMethod,
      amount: data.amount,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-nab-payment',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/nab/payment',
        service: 'customer-nab-payment',
        productCode: account.productCode,
        paymentMethod: data.paymentMethod,
      },
      extra: {
        requestId,
        receiptNumber,
        fromAccount: data.fromAccount,
        productCode: account.productCode,
        paymentMethod: data.paymentMethod,
        amount: data.amount,
        payeeName: data.payeeName,
        payeeBsb: data.payeeBsb,
        payeeAccount: data.payeeAccount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/nab.js — calculatePaymentSettlement',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-nab-payment',
      verticalLabel: 'NAB Internet Banking — Pay someone',
      customer: 'nab',
      slackMemberId: data.devinEmail ? '' : NAB_SLACK_MEMBER_ID,
      slackMemberIdFallback: NAB_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/nab/payment' },
        { key: 'service', value: 'customer-nab-payment' },
        { key: 'productCode', value: account.productCode },
        { key: 'paymentMethod', value: data.paymentMethod },
      ],
      extra: {
        requestId,
        receiptNumber,
        fromAccount: data.fromAccount,
        productCode: account.productCode,
        paymentMethod: data.paymentMethod,
        amount: data.amount,
        payeeName: data.payeeName,
        payeeBsb: data.payeeBsb,
        payeeAccount: data.payeeAccount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-nab-payment@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for NAB payment error', {
        requestId,
        receiptNumber,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitPayment,
  resolvePaymentLimitSchedule,
  selectSettlementRail,
  calculateTransferFee,
  estimateArrival,
  calculatePaymentSettlement,
  ACCOUNTS,
  PAYMENT_LIMIT_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
