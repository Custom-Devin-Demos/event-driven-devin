const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ACCOUNTS = {
  '502113847': {
    accountId: '502113847',
    accountName: 'Everyday Options',
    bsb: '484-799',
    accountNumber: '502113847',
    productCode: 'everyday_options_2026',
    productLabel: 'Everyday Options (2026)',
    availableBalance: 4812.55,
  },
  '447290163': {
    accountId: '447290163',
    accountName: 'Growth Saver',
    bsb: '484-799',
    accountNumber: '447290163',
    productCode: 'growth_saver',
    productLabel: 'Growth Saver',
    availableBalance: 18240.10,
  },
  '610845572': {
    accountId: '610845572',
    accountName: 'Business Premium',
    bsb: '484-799',
    accountNumber: '610845572',
    productCode: 'business_premium',
    productLabel: 'Business Premium Account',
    availableBalance: 96320.75,
  },
};

const PAYEES = {
  'PAY-1001': {
    payeeId: 'PAY-1001',
    name: 'Sarah Whitcombe',
    nickname: 'Sarah — rent',
    bsb: '124-001',
    accountNumber: '10294477',
    payId: 'sarah.w@email.com.au',
  },
  'PAY-1002': {
    payeeId: 'PAY-1002',
    name: 'Brisbane City Council',
    nickname: 'Council rates',
    bsb: '064-000',
    accountNumber: '88213004',
  },
  'PAY-1003': {
    payeeId: 'PAY-1003',
    name: 'Northside Plumbing Pty Ltd',
    nickname: 'Plumber',
    bsb: '484-799',
    accountNumber: '503992118',
  },
};

const LIMIT_SCHEDULES = {
  // everyday_options_2026 joins the payment-limit table with the 1 October 2026 limit uplift; schedule registration pending
  growth_saver: {
    label: 'Growth Saver',
    dailyPaymentLimit: 5000,
    payIdLimit: 3000,
    oskoEnabled: true,
    settlementQueue: 'retail-standard',
  },
  business_premium: {
    label: 'Business Premium Account',
    dailyPaymentLimit: 50000,
    payIdLimit: 25000,
    oskoEnabled: true,
    settlementQueue: 'business-priority',
  },
};

const SUNCORP_SLACK_MEMBER_ID = process.env.SUNCORP_SLACK_MEMBER_ID || '';
const SENTRY_ISSUE_QUERY = 'is:unresolved dailyPaymentLimit';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Suncorp Internet Banking payment failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues. Ignore every issue that is not from POST /api/suncorp/payment, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Suncorp Bank Internet Banking "Pay someone" page at app/public/verticals/suncorp.html (page route GET /suncorp), whose "Pay now" action posts to POST /api/suncorp/payment in app/routes/verticals/suncorp.js. The payment authorisation pipeline lives in app/services/verticals/suncorp.js: submitPayment -> calculatePaymentAuthorisation -> resolveLimitSchedule. Start at resolveLimitSchedule: it looks up LIMIT_SCHEDULES by the account product code, and the everyday_options_2026 product joined the payment-limit table with the 1 October 2026 limit uplift without a registered limit schedule, so the lookup returns undefined and calculatePaymentAuthorisation dereferences it while applying the daily payment limit. Register the missing product's payment-limit schedule and make the lookup fail as a handled banking error routed to the appropriate settlement queue instead of a TypeError. Do not change the page's look and feel, do not touch the HCF vertical, and do not touch any other vertical. Verify by starting the server (node app/server.js) and POSTing the default payment to /api/suncorp/payment, which must return a successful payment authorisation, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /suncorp page in a real browser, submit the pre-filled payment for the default Everyday Options account, and record your screen for the whole submission so the recording shows the payment form, the click, and the successful authorisation that replaces the previous TypeError panel. Attach a screenshot of that successful payment authorisation and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function resolveLimitSchedule(account) {
  return LIMIT_SCHEDULES[account.productCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function assignSettlementQueue(schedule) {
  return schedule.settlementQueue;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_PAYMENT';
  error.statusCode = 400;
  return error;
}

function calculatePaymentAuthorisation(account, payment) {
  const schedule = resolveLimitSchedule(account);
  const dailyPaymentLimit = schedule.dailyPaymentLimit;
  const applicableLimit = payment.payMethod === 'payid'
    ? schedule.payIdLimit
    : dailyPaymentLimit;
  const limitLabel = payment.payMethod === 'payid'
    ? 'PayID payment limit'
    : 'daily payment limit';

  if (payment.amount > applicableLimit) {
    throw validationError(
      `Payment of $${payment.amount} exceeds your ${limitLabel} of $${applicableLimit}`,
    );
  }
  if (payment.amount > account.availableBalance) {
    throw validationError(
      `Payment of $${payment.amount} exceeds your available balance of $${account.availableBalance}`,
    );
  }

  return {
    schedule,
    dailyPaymentLimit,
    remainingDailyLimit: roundMoney(dailyPaymentLimit - payment.amount),
    settlementQueue: assignSettlementQueue(schedule),
  };
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function maskAccountNumber(account) {
  return `${account.bsb} ****${account.accountNumber.slice(-4)}`;
}

function makeReceiptNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
  return `SUN-${digits}`;
}

async function submitPayment(data) {
  const startTime = Date.now();
  const receiptNumber = makeReceiptNumber();
  const fromAccountId = data.fromAccountId;
  const payeeId = data.payeeId;
  const account = ACCOUNTS[fromAccountId];
  const payee = PAYEES[payeeId];
  const amount = Number(data.amount);
  const paymentDate = data.paymentDate;

  if (!fromAccountId || !String(fromAccountId).trim() || !account) {
    throw validationError(`Unknown from account: ${fromAccountId || '(none)'}`);
  }
  if (!payeeId || !String(payeeId).trim() || !payee) {
    throw validationError(`Unknown payee: ${payeeId || '(none)'}`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw validationError('Payment amount must be a positive number');
  }
  if (!isCalendarDate(paymentDate)) {
    throw validationError('Payment date must be a valid YYYY-MM-DD calendar date');
  }

  logger.info('Submitting Suncorp payment', {
    receiptNumber,
    fromAccountId,
    payeeId,
    amount,
    paymentDate,
    service: 'customer-suncorp-payment',
    route: '/api/suncorp/payment',
  });

  try {
    const payment = {
      amount,
      description: data.description,
      paymentDate,
      payMethod: data.payMethod,
    };
    const authorisation = calculatePaymentAuthorisation(account, payment);
    const submittedAt = new Date().toISOString();
    const clearedAt = data.payMethod === 'osko'
      ? 'Within 60 seconds'
      : 'Next business day';
    const duration = Date.now() - startTime;

    incrementMetric('suncorp_payment.success', {
      route: '/api/suncorp/payment',
      productCode: account.productCode,
      payMethod: data.payMethod,
    });
    recordTiming('suncorp_payment.latency', duration, {
      route: '/api/suncorp/payment',
    });

    return {
      success: true,
      status: 'authorised',
      receiptNumber,
      paymentReference: receiptNumber,
      fromAccountId,
      accountName: account.accountName,
      fromAccount: maskAccountNumber(account),
      payeeId,
      payeeName: payee.name,
      payeeNickname: payee.nickname,
      payeeBsb: payee.bsb,
      payeeAccountNumber: payee.accountNumber,
      amount,
      description: data.description,
      paymentDate,
      payMethod: data.payMethod,
      productLabel: account.productLabel,
      dailyPaymentLimit: authorisation.dailyPaymentLimit,
      remainingDailyLimit: authorisation.remainingDailyLimit,
      availableBalance: account.availableBalance,
      settlementQueue: authorisation.settlementQueue,
      clearedAt,
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'ValidationError') {
      incrementMetric('suncorp_payment.failure', {
        route: '/api/suncorp/payment',
        errorClass: error.name,
        productCode: account.productCode,
        payMethod: data.payMethod,
      });
      recordTiming('suncorp_payment.latency', duration, {
        route: '/api/suncorp/payment',
        error: 'true',
      });
      throw error;
    }

    incrementMetric('suncorp_payment.failure', {
      route: '/api/suncorp/payment',
      errorClass: error.name,
      productCode: account.productCode,
      payMethod: data.payMethod,
    });
    recordTiming('suncorp_payment.latency', duration, {
      route: '/api/suncorp/payment',
      error: 'true',
    });

    logger.error('Suncorp payment submission failed', {
      receiptNumber,
      fromAccountId,
      payeeId,
      amount,
      paymentDate,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-suncorp-payment',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/suncorp/payment',
        service: 'customer-suncorp-payment',
        productCode: account.productCode,
        productLabel: account.productLabel,
      },
      extra: {
        receiptNumber,
        paymentReference: receiptNumber,
        fromAccount: maskAccountNumber(account),
        payeeName: payee.name,
        amount,
        paymentDate,
        payMethod: data.payMethod,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/suncorp.js — calculatePaymentAuthorisation',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-suncorp-payment',
      verticalLabel: 'Suncorp Bank Internet Banking — Pay Someone',
      customer: 'suncorp',
      slackMemberId: data.devinEmail ? '' : SUNCORP_SLACK_MEMBER_ID,
      slackMemberIdFallback: SUNCORP_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/suncorp/payment' },
        { key: 'service', value: 'customer-suncorp-payment' },
        { key: 'productCode', value: account.productCode },
        { key: 'productLabel', value: account.productLabel },
        { key: 'payMethod', value: data.payMethod },
      ],
      extra: {
        receiptNumber,
        paymentReference: receiptNumber,
        fromAccount: maskAccountNumber(account),
        payeeName: payee.name,
        amount,
        paymentDate,
        payMethod: data.payMethod,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-suncorp-payment@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Suncorp payment error', {
        receiptNumber,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitPayment,
  resolveLimitSchedule,
  calculatePaymentAuthorisation,
  assignSettlementQueue,
  roundMoney,
  ACCOUNTS,
  PAYEES,
  LIMIT_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
