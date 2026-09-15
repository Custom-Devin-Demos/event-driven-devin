const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const TAX_ACCOUNTS = {
  'TAX-IIT-2026': {
    accountId: 'TAX-IIT-2026',
    taxType: 'Income Tax',
    assessmentCycle: 'ya2026',
    referenceNumber: 'D****000X',
    balance: 1284.50,
  },
  'TAX-PTX-2026': {
    accountId: 'TAX-PTX-2026',
    taxType: 'Property Tax',
    assessmentCycle: 'ya2026',
    referenceNumber: 'D****000X',
    balance: 640.00,
  },
  'TAX-SD-2026': {
    accountId: 'TAX-SD-2026',
    taxType: 'Stamp Duty',
    assessmentCycle: 'ya2026',
    referenceNumber: 'D****000X',
    balance: 3520.00,
  },
};

const FUNDING_ACCOUNTS = {
  'ACCT-1001': { accountId: 'ACCT-1001', label: 'Demo Savings Bank ····4821' },
  'ACCT-1002': { accountId: 'ACCT-1002', label: 'Sample Credit Union ····1190' },
  'ACCT-1003': { accountId: 'ACCT-1003', label: 'Example Trust Account ····7734' },
};

const PAYMENT_MODES = {
  ibanking: { label: 'Internet Banking Transfer', clearingDays: 0 },
  qr: { label: 'QR Payment', clearingDays: 0 },
  debit: { label: 'Direct Debit One-Time Deduction', clearingDays: 3 },
};

const LEDGER_SCHEDULES = {
  ya2025: {
    label: 'Year of Assessment 2025',
    postingDays: 1,
    lateFeeRate: 0.05,
    receiptPrefix: 'PA25',
    reconciliationQueue: 'revenue-ledger-2025',
  },
  // ya2026 cycle opened with the 2026 assessment rollover; ledger schedule registration pending
};

const TAX_PORTAL_SLACK_MEMBER_ID = process.env.TAX_PORTAL_SLACK_MEMBER_ID || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved postingDays';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Tax Revenue Portal payment failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/insurance/claim and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/3640b94c/payment, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Tax Revenue Portal "Pay Taxes" page at app/public/verticals/3640b94c.html (page route GET /3640b94c, alias GET /tax-portal), whose "Continue" action posts to POST /api/3640b94c/payment in app/routes/verticals/3640b94c.js. The payment posting pipeline lives in app/services/verticals/3640b94c.js: submitTaxPayment -> calculatePaymentPosting -> resolveLedgerSchedule. Start at resolveLedgerSchedule: it looks up LEDGER_SCHEDULES by the assessment cycle carried on the tax account, and the ya2026 cycle opened with the 2026 assessment rollover without a registered ledger schedule, so the lookup returns undefined and calculatePaymentPosting dereferences it while computing the posting date. Register the missing cycle's ledger schedule and make the lookup fail as a handled payments error routed to the revenue-ledger reconciliation queue instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing an Internet Banking payment for tax account TAX-IIT-2026 to /api/3640b94c/payment, which must return a successful payment acknowledgement, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /3640b94c page in a real browser, submit the pre-filled Income Tax payment, and record your screen for the whole submission so the recording shows the form, the click, and the successful payment acknowledgement that replaces the previous failure panel. Attach a screenshot of that successful acknowledgement and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function resolveLedgerSchedule(taxAccount) {
  return LEDGER_SCHEDULES[taxAccount.assessmentCycle];
}

function computePostingDate(schedule, mode) {
  const posted = new Date();
  posted.setDate(posted.getDate() + schedule.postingDays + mode.clearingDays);
  return posted.toISOString();
}

function buildAcknowledgementNumber(schedule) {
  return `${schedule.receiptPrefix}${String(Date.now()).slice(-9)}`;
}

function calculatePaymentPosting(taxAccount, payment, mode) {
  const schedule = resolveLedgerSchedule(taxAccount);
  const postingDate = computePostingDate(schedule, mode);
  const acknowledgementNumber = buildAcknowledgementNumber(schedule);

  return {
    schedule,
    postingDate,
    acknowledgementNumber,
    remainingBalance: Math.max(0, taxAccount.balance - payment.amount),
    reconciliationQueue: schedule.reconciliationQueue,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_PAYMENT';
  error.statusCode = 400;
  return error;
}

async function submitTaxPayment(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const taxAccount = TAX_ACCOUNTS[data.taxAccount];
  const fundingAccount = FUNDING_ACCOUNTS[data.fromAccount];
  const mode = PAYMENT_MODES[data.paymentMode];
  const payment = { amount: data.amount, paymentMode: data.paymentMode };

  if (!taxAccount) {
    throw validationError(`Unknown tax account: ${data.taxAccount || '(none)'}`);
  }
  if (!fundingAccount) {
    throw validationError(`Unknown funding account: ${data.fromAccount || '(none)'}`);
  }
  if (!mode) {
    throw validationError('Unsupported payment mode');
  }
  if (!(data.amount >= 1)) {
    throw validationError('Payment amount must be at least 1.00');
  }
  if (data.amount > taxAccount.balance + 0.005) {
    throw validationError(`Payment amount exceeds the ${taxAccount.balance.toFixed(2)} payable on this tax account`);
  }

  logger.info('Submitting tax payment', {
    requestId,
    taxAccount: data.taxAccount,
    fromAccount: data.fromAccount,
    paymentMode: data.paymentMode,
    amount: data.amount,
    service: 'customer-3640b94c-payment',
    route: '/api/3640b94c/payment',
  });

  try {
    const posting = calculatePaymentPosting(taxAccount, payment, mode);
    const duration = Date.now() - startTime;

    incrementMetric('tax_payment.success', {
      route: '/api/3640b94c/payment',
      assessmentCycle: taxAccount.assessmentCycle,
      paymentMode: data.paymentMode,
    });
    recordTiming('tax_payment.latency', duration, {
      route: '/api/3640b94c/payment',
    });

    return {
      success: true,
      acknowledgementNumber: posting.acknowledgementNumber,
      taxAccount: taxAccount.accountId,
      taxType: taxAccount.taxType,
      fromAccount: fundingAccount.accountId,
      paymentMode: mode.label,
      amount: data.amount,
      postingDate: posting.postingDate,
      remainingBalance: posting.remainingBalance,
      requestId,
    };
  } catch (error) {
    if (error.name === 'ValidationError') {
      throw error;
    }

    const duration = Date.now() - startTime;

    incrementMetric('tax_payment.failure', {
      route: '/api/3640b94c/payment',
      errorClass: error.name,
      assessmentCycle: taxAccount.assessmentCycle,
      paymentMode: data.paymentMode,
    });
    recordTiming('tax_payment.latency', duration, {
      route: '/api/3640b94c/payment',
      error: 'true',
    });

    logger.error('Tax payment submission failed', {
      requestId,
      taxAccount: data.taxAccount,
      fromAccount: data.fromAccount,
      paymentMode: data.paymentMode,
      amount: data.amount,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-3640b94c-payment',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/3640b94c/payment',
        service: 'customer-3640b94c-payment',
        assessmentCycle: taxAccount.assessmentCycle,
        paymentMode: data.paymentMode,
      },
      extra: {
        requestId,
        taxAccount: data.taxAccount,
        taxType: taxAccount.taxType,
        assessmentCycle: taxAccount.assessmentCycle,
        fromAccount: data.fromAccount,
        paymentMode: data.paymentMode,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/3640b94c.js — calculatePaymentPosting',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-3640b94c-payment',
      verticalLabel: 'Tax Revenue Portal — Pay Taxes',
      customer: '3640b94c',
      slackMemberId: data.devinEmail ? '' : TAX_PORTAL_SLACK_MEMBER_ID,
      slackMemberIdFallback: TAX_PORTAL_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/3640b94c/payment' },
        { key: 'service', value: 'customer-3640b94c-payment' },
        { key: 'assessmentCycle', value: taxAccount.assessmentCycle },
        { key: 'paymentMode', value: data.paymentMode },
      ],
      extra: {
        requestId,
        taxAccount: data.taxAccount,
        taxType: taxAccount.taxType,
        assessmentCycle: taxAccount.assessmentCycle,
        fromAccount: data.fromAccount,
        paymentMode: data.paymentMode,
        amount: data.amount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-3640b94c-payment@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for tax payment error', {
        requestId,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  submitTaxPayment,
  resolveLedgerSchedule,
  computePostingDate,
  buildAcknowledgementNumber,
  calculatePaymentPosting,
  TAX_ACCOUNTS,
  FUNDING_ACCOUNTS,
  PAYMENT_MODES,
  LEDGER_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
