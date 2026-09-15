const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ACCOUNTS = {
  '512 483 771': {
    accountNumber: '512 483 771',
    accountType: 'One Bill',
    holderName: 'Jordan Tremblay',
    balanceDue: 186.42,
    dueDate: '2026-10-02',
    billDate: '2026-09-12',
    services: [
      { type: 'Mobility', number: '(514) 555-0142', nickname: 'Jordan — iPhone 17' },
      { type: 'Mobility', number: '(514) 555-0198', nickname: 'Camille' },
      { type: 'Mobility', number: '(438) 555-0310', nickname: 'Élise' },
      { type: 'Mobility', number: '(438) 555-0377', nickname: 'Work line' },
      { type: 'Mobility', number: '(514) 555-0455', nickname: 'Tablet' },
    ],
  },
};

const PAYMENT_METHODS = {
  online_banking: { label: 'Online or telephone banking' },
  interac_etransfer: { label: 'Interac e-Transfer' },
  credit_card: { label: 'Credit card' },
  bell_store: { label: 'Bell store' },
  mail_cheque: { label: 'Cheque by mail' },
};

const POSTING_SCHEDULES = {
  online_banking: {
    label: 'Online or telephone banking',
    postingDays: 2,
    clearingRail: 'EFT',
    holdsCollections: true,
    reviewQueue: 'payments-banking',
  },
  credit_card: {
    label: 'Credit card',
    postingDays: 1,
    clearingRail: 'card',
    holdsCollections: true,
    reviewQueue: 'payments-card',
  },
  bell_store: {
    label: 'Bell store',
    postingDays: 0,
    clearingRail: 'pos',
    holdsCollections: true,
    reviewQueue: 'payments-retail',
  },
  mail_cheque: {
    label: 'Cheque by mail',
    postingDays: 7,
    clearingRail: 'lockbox',
    holdsCollections: false,
    reviewQueue: 'payments-lockbox',
  },
  // interac_etransfer ships with the 2026 payment-channel refresh; posting schedule registration pending
};

const BELL_SLACK_MEMBER_ID = process.env.BELL_SLACK_MEMBER_ID || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved postingDays';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Bell MyBell payment-notification failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/insurance/claim and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/e0f65e64/payment-notification, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Bell MyBell account overview at app/public/verticals/e0f65e64.html (served at GET /e0f65e64, aliases /bell and /mybell), whose "Notify Bell of a payment" flow posts to POST /api/e0f65e64/payment-notification in app/routes/verticals/e0f65e64.js. The payment-notification pipeline lives in app/services/verticals/e0f65e64.js: notifyPayment -> calculatePaymentPosting -> resolvePostingSchedule. Start at resolvePostingSchedule: it looks up POSTING_SCHEDULES by the payment method the customer selected, and the interac_etransfer method shipped with the 2026 payment-channel refresh in PAYMENT_METHODS without a registered posting schedule, so the lookup returns undefined and calculatePaymentPosting dereferences it while computing the expected posting date. Register the missing method's posting schedule and make the lookup fail as a handled payments error routed to the payments operations queue instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing an Interac e-Transfer payment notification for account 512 483 771 to /api/e0f65e64/payment-notification, which must return a successful confirmation, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /bell page in a real browser, click "Notify Bell of a payment", submit the pre-filled Interac e-Transfer notification through the review step, and record your screen for the whole submission so the recording shows the form, the review, the click, and the successful confirmation that replaces the previous TypeError panel. Attach a screenshot of that confirmation and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = 'INVALID_PAYMENT_NOTIFICATION';
  return error;
}

function isValidPaymentDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return false;
  return value <= new Date().toISOString().slice(0, 10);
}

function addBusinessDays(fromDate, days) {
  const date = new Date(fromDate);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function resolvePostingSchedule(paymentMethod) {
  return POSTING_SCHEDULES[paymentMethod];
}

function calculatePaymentPosting(account, payment) {
  const schedule = resolvePostingSchedule(payment.paymentMethod);

  const expectedPostingDate = addBusinessDays(payment.paymentDate, schedule.postingDays);
  const collectionsHoldUntil = schedule.holdsCollections
    ? addBusinessDays(expectedPostingDate, 3)
    : null;
  const remainingBalance = Math.max(0, Math.round((account.balanceDue - payment.amount) * 100) / 100);

  return {
    schedule,
    expectedPostingDate,
    collectionsHoldUntil,
    remainingBalance,
    clearingRail: schedule.clearingRail,
    reviewQueue: schedule.reviewQueue,
  };
}

async function notifyPayment(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const confirmationNumber = `BN${Math.floor(Math.random() * 1000000000).toString().padStart(9, '0')}`;
  const account = ACCOUNTS[data.accountNumber];
  const payment = {
    paymentMethod: data.paymentMethod,
    amount: data.amount,
    paymentDate: data.paymentDate,
    referenceNumber: data.referenceNumber,
  };

  if (!account) {
    throw validationError(`Unknown account number: ${data.accountNumber || '(none)'}`);
  }
  if (!Number.isFinite(data.amount) || data.amount <= 0) {
    throw validationError('Payment amount must be a finite number greater than zero');
  }
  if (!PAYMENT_METHODS[data.paymentMethod]) {
    throw validationError('Unsupported payment method');
  }
  if (!isValidPaymentDate(data.paymentDate)) {
    throw validationError('Payment date must be a valid YYYY-MM-DD date that is not in the future');
  }

  logger.info('Submitting Bell payment notification', {
    requestId,
    confirmationNumber,
    accountNumber: data.accountNumber,
    paymentMethod: data.paymentMethod,
    amount: data.amount,
    service: 'customer-e0f65e64-payment-notification',
    route: '/api/e0f65e64/payment-notification',
  });

  try {
    const posting = calculatePaymentPosting(account, payment);
    const duration = Date.now() - startTime;

    incrementMetric('bell_payment_notification.success', {
      route: '/api/e0f65e64/payment-notification',
      paymentMethod: data.paymentMethod,
    });
    recordTiming('bell_payment_notification.latency', duration, {
      route: '/api/e0f65e64/payment-notification',
    });

    return {
      success: true,
      confirmationNumber,
      accountNumber: account.accountNumber,
      holderName: account.holderName,
      paymentMethod: data.paymentMethod,
      paymentMethodLabel: PAYMENT_METHODS[data.paymentMethod].label,
      amount: data.amount,
      paymentDate: data.paymentDate,
      expectedPostingDate: posting.expectedPostingDate,
      collectionsHoldUntil: posting.collectionsHoldUntil,
      remainingBalance: posting.remainingBalance,
      clearingRail: posting.clearingRail,
      requestId,
    };
  } catch (error) {
    if (error.name === 'ValidationError') {
      throw error;
    }

    const duration = Date.now() - startTime;

    incrementMetric('bell_payment_notification.failure', {
      route: '/api/e0f65e64/payment-notification',
      errorClass: error.name,
      paymentMethod: data.paymentMethod,
    });
    recordTiming('bell_payment_notification.latency', duration, {
      route: '/api/e0f65e64/payment-notification',
      error: 'true',
    });

    logger.error('Bell payment notification failed', {
      requestId,
      confirmationNumber,
      accountNumber: data.accountNumber,
      paymentMethod: data.paymentMethod,
      amount: data.amount,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-e0f65e64-payment-notification',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/e0f65e64/payment-notification',
        service: 'customer-e0f65e64-payment-notification',
        paymentMethod: data.paymentMethod,
      },
      extra: {
        requestId,
        confirmationNumber,
        accountNumber: data.accountNumber,
        paymentMethod: data.paymentMethod,
        amount: data.amount,
        paymentDate: data.paymentDate,
        referenceNumber: data.referenceNumber,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/e0f65e64.js — calculatePaymentPosting',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-e0f65e64-payment-notification',
      verticalLabel: 'Bell MyBell — Notify Bell of a payment',
      customer: 'e0f65e64',
      slackMemberId: data.devinEmail ? '' : BELL_SLACK_MEMBER_ID,
      slackMemberIdFallback: BELL_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/e0f65e64/payment-notification' },
        { key: 'service', value: 'customer-e0f65e64-payment-notification' },
        { key: 'paymentMethod', value: data.paymentMethod },
      ],
      extra: {
        requestId,
        confirmationNumber,
        accountNumber: data.accountNumber,
        paymentMethod: data.paymentMethod,
        amount: data.amount,
        paymentDate: data.paymentDate,
        referenceNumber: data.referenceNumber,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-e0f65e64-payment-notification@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Bell payment notification error', {
        requestId,
        confirmationNumber,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  notifyPayment,
  resolvePostingSchedule,
  calculatePaymentPosting,
  addBusinessDays,
  ACCOUNTS,
  PAYMENT_METHODS,
  POSTING_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
