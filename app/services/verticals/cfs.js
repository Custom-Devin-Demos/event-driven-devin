const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const MEMBER_ACCOUNTS = {
  'CFS-2044186': {
    memberAccountId: 'CFS-2044186',
    memberName: 'Hannah Delacroix',
    productCode: 'cfs_firstchoice_wholesale_pension',
    productLabel: 'FirstChoice Wholesale Pension',
    balance: 742318.45,
    preservation: 'Unrestricted non-preserved',
    fund: 'Colonial First State FirstChoice Superannuation Trust',
    usi: 'FSF0006AU',
    paymentDestination: 'Commonwealth Bank •••• 4471',
    paymentBsb: '062-000',
    paymentAccountEnding: '4471',
  },
  'CFS-6721903': {
    memberAccountId: 'CFS-6721903',
    memberName: 'Nathan Ellery',
    productCode: 'cfs_firstchoice_employer_super',
    productLabel: 'FirstChoice Employer Super',
    balance: 218904.33,
    preservation: 'Preserved',
    fund: 'Colonial First State FirstChoice Superannuation Trust',
    usi: 'FSF0006AU',
    paymentDestination: 'Commonwealth Bank •••• 4471',
    paymentBsb: '062-000',
    paymentAccountEnding: '4471',
  },
  'CFS-9158740': {
    memberAccountId: 'CFS-9158740',
    memberName: 'Marguerite Osei',
    productCode: 'cfs_edge_super',
    productLabel: 'CFS Edge Super',
    balance: 1043277.10,
    preservation: 'Unrestricted non-preserved',
    fund: 'Colonial First State FirstChoice Superannuation Trust',
    usi: 'FSF0006AU',
    paymentDestination: 'Commonwealth Bank •••• 4471',
    paymentBsb: '062-000',
    paymentAccountEnding: '4471',
  },
};

const WITHDRAWAL_RULES = {
  // cfs_firstchoice_wholesale_pension pension products moved to the FY26 withdrawal-rules registry; registration pending
  cfs_firstchoice_employer_super: {
    label: 'FirstChoice Employer Super',
    maxLumpSumPercent: 90,
    minResidualBalance: 6000,
    maxAnnualWithdrawals: 4,
    paymentProcessingDays: 5,
    settlementQueue: 'employer-super-daily',
  },
  cfs_edge_super: {
    label: 'CFS Edge Super',
    maxLumpSumPercent: 95,
    minResidualBalance: 10000,
    maxAnnualWithdrawals: 6,
    paymentProcessingDays: 3,
    settlementQueue: 'edge-daily',
  },
};

const CFS_SLACK_MEMBER_ID = process.env.CFS_SLACK_MEMBER_ID || '';
const SENTRY_ISSUE_QUERY = 'is:unresolved maxLumpSumPercent';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the CFS member online lump sum withdrawal failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues. Ignore every issue that is not from POST /api/cfs/withdrawal, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. Explicitly exclude QBE, HCF, Suncorp, Insignia, HUB24, Morgan Stanley, and every unrelated vertical. The failing surface is the CFS member online "Withdraw from your super" page at app/public/verticals/cfs.html (page route GET /cfs), whose "Submit withdrawal request" action posts to POST /api/cfs/withdrawal in app/routes/verticals/cfs.js. The lump sum withdrawal pipeline lives in app/services/verticals/cfs.js: submitWithdrawal -> calculateLumpSumWithdrawal -> resolveWithdrawalRules. Start at resolveWithdrawalRules: it looks up WITHDRAWAL_RULES by the member account's product code, and cfs_firstchoice_wholesale_pension is intentionally absent because pension products moved to the FY26 withdrawal-rules registry, so the lookup returns undefined and calculateLumpSumWithdrawal dereferences it while applying the maximum lump sum percentage. Fix this by registering the missing cfs_firstchoice_wholesale_pension withdrawal rules entry; do not patch around the crash or modify any other vertical. Verify by starting the server (node app/server.js), curling POST /api/cfs/withdrawal, and confirming npm run lint passes. Visual Fix Verification is mandatory: open the CFS page in a real browser, submit an accepted withdrawal after the fix, and capture browser evidence showing the member online form, the submit action, and the accepted confirmation.`;

function resolveWithdrawalRules(account) {
  return WITHDRAWAL_RULES[account.productCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function roundPercent(value) {
  return Math.round(value * 100) / 100;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_WITHDRAWAL_REQUEST';
  error.statusCode = 400;
  return error;
}

function isCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function makeReceiptNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 8).padEnd(8, '0');
  return `CFS-${digits}`;
}

function makeWithdrawalReference() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 10).padEnd(10, '0');
  return `CFS-WD-${digits}`;
}

function addBusinessishDays(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

function calculateLumpSumWithdrawal(account, request) {
  const rules = resolveWithdrawalRules(account);
  const maxLumpSumPercent = rules.maxLumpSumPercent;
  const grossWithdrawalAmount = request.amountBasis === 'percentage'
    ? roundMoney(account.balance * request.withdrawalAmount / 100)
    : roundMoney(request.withdrawalAmount);
  const effectiveWithdrawalPercent = roundPercent(grossWithdrawalAmount / account.balance * 100);
  const residualBalance = roundMoney(account.balance - grossWithdrawalAmount);

  if (effectiveWithdrawalPercent > maxLumpSumPercent) {
    throw validationError(
      `Withdrawal of ${effectiveWithdrawalPercent}% exceeds the ${maxLumpSumPercent}% maximum on ${account.productLabel}`,
    );
  }
  if (residualBalance < rules.minResidualBalance) {
    throw validationError(
      `Residual balance of $${residualBalance.toFixed(2)} is below the $${rules.minResidualBalance} minimum required on ${account.productLabel}`,
    );
  }

  return {
    rules,
    maxLumpSumPercent,
    grossWithdrawalAmount,
    effectiveWithdrawalPercent,
    residualBalance,
    estimatedSettlementDate: addBusinessishDays(request.paymentDate, rules.paymentProcessingDays),
    settlementQueue: rules.settlementQueue,
    appliedAtText: `Payment scheduled for processing from ${request.paymentDate}`,
  };
}

async function submitWithdrawal(data) {
  const startTime = Date.now();
  const receiptNumber = makeReceiptNumber();
  const withdrawalReference = makeWithdrawalReference();
  const memberAccountId = data.memberAccountId;
  const account = MEMBER_ACCOUNTS[memberAccountId];
  const amountBasis = data.amountBasis;
  const withdrawalAmount = data.withdrawalAmount;
  const paymentDestination = data.paymentDestination;
  const paymentDate = data.paymentDate;
  const memberDeclaration = data.memberDeclaration;

  if (!memberAccountId || !String(memberAccountId).trim() || !account) {
    throw validationError(`Unknown member account: ${memberAccountId || '(none)'}`);
  }
  if (!['amount', 'percentage'].includes(amountBasis)) {
    throw validationError('Amount basis must be amount or percentage');
  }
  if (!Number.isFinite(withdrawalAmount) || withdrawalAmount <= 0) {
    throw validationError('Withdrawal amount must be a positive number');
  }
  if (amountBasis === 'percentage' && withdrawalAmount > 100) {
    throw validationError('Percentage withdrawal amount cannot exceed 100%');
  }
  if (typeof paymentDestination !== 'string' || !paymentDestination.trim()) {
    throw validationError('Payment destination is required');
  }
  if (!isCalendarDate(paymentDate)) {
    throw validationError('Payment date must be a valid YYYY-MM-DD calendar date');
  }
  if (memberDeclaration !== true) {
    throw validationError('Member declaration is required before a withdrawal can be submitted');
  }

  logger.info('Submitting CFS lump sum withdrawal', {
    receiptNumber,
    withdrawalReference,
    memberAccountId,
    amountBasis,
    withdrawalAmount,
    paymentDestination,
    paymentDate,
    channel: data.channel,
    service: 'customer-cfs-withdrawal',
    route: '/api/cfs/withdrawal',
  });

  try {
    const withdrawal = calculateLumpSumWithdrawal(account, {
      amountBasis,
      withdrawalAmount,
      paymentDate,
    });
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('cfs_withdrawal.success', {
      route: '/api/cfs/withdrawal',
      productCode: account.productCode,
      amountBasis,
    });
    recordTiming('cfs_withdrawal.latency', duration, {
      route: '/api/cfs/withdrawal',
    });

    return {
      success: true,
      status: 'accepted',
      withdrawalReference,
      receiptNumber,
      memberAccountId,
      memberName: account.memberName,
      productLabel: account.productLabel,
      fund: account.fund,
      usi: account.usi,
      balance: account.balance,
      preservation: account.preservation,
      amountBasis,
      grossWithdrawalAmount: withdrawal.grossWithdrawalAmount,
      effectiveWithdrawalPercent: withdrawal.effectiveWithdrawalPercent,
      maxLumpSumPercent: withdrawal.maxLumpSumPercent,
      residualBalance: withdrawal.residualBalance,
      paymentDestination,
      paymentDate,
      estimatedSettlementDate: withdrawal.estimatedSettlementDate,
      settlementQueue: withdrawal.settlementQueue,
      appliedAtText: withdrawal.appliedAtText,
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'ValidationError') {
      incrementMetric('cfs_withdrawal.failure', {
        route: '/api/cfs/withdrawal',
        errorClass: error.name,
        productCode: account.productCode,
        amountBasis,
      });
      recordTiming('cfs_withdrawal.latency', duration, {
        route: '/api/cfs/withdrawal',
        error: 'true',
      });
      throw error;
    }

    incrementMetric('cfs_withdrawal.failure', {
      route: '/api/cfs/withdrawal',
      errorClass: error.name,
      productCode: account.productCode,
      amountBasis,
    });
    recordTiming('cfs_withdrawal.latency', duration, {
      route: '/api/cfs/withdrawal',
      error: 'true',
    });

    logger.error('CFS lump sum withdrawal failed', {
      receiptNumber,
      withdrawalReference,
      memberAccountId,
      amountBasis,
      withdrawalAmount,
      paymentDestination,
      paymentDate,
      channel: data.channel,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-cfs-withdrawal',
      route: '/api/cfs/withdrawal',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/cfs/withdrawal',
        service: 'customer-cfs-withdrawal',
        productCode: account.productCode,
        productLabel: account.productLabel,
        amountBasis,
      },
      extra: {
        receiptNumber,
        withdrawalReference,
        memberAccountId,
        memberName: account.memberName,
        withdrawalAmount,
        paymentDestination,
        paymentDate,
        channel: data.channel,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/cfs.js — calculateLumpSumWithdrawal',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-cfs-withdrawal',
      verticalLabel: 'CFS — Lump Sum Withdrawal (Member Online)',
      customer: 'cfs',
      slackMemberId: data.devinEmail ? '' : CFS_SLACK_MEMBER_ID,
      slackMemberIdFallback: CFS_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/cfs/withdrawal' },
        { key: 'service', value: 'customer-cfs-withdrawal' },
        { key: 'productCode', value: account.productCode },
        { key: 'productLabel', value: account.productLabel },
        { key: 'amountBasis', value: amountBasis },
      ],
      extra: {
        receiptNumber,
        withdrawalReference,
        memberAccountId,
        memberName: account.memberName,
        withdrawalAmount,
        paymentDestination,
        paymentDate,
        channel: data.channel,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-cfs-withdrawal@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for CFS withdrawal error', {
        receiptNumber,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitWithdrawal,
  resolveWithdrawalRules,
  calculateLumpSumWithdrawal,
  roundMoney,
  MEMBER_ACCOUNTS,
  WITHDRAWAL_RULES,
  REMEDIATION_DIRECTIVE,
};
