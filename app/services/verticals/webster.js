const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'webster-transfers-api';
const ROUTE = '/api/webster/transfer';
const PAGE = '/webster';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Webster Bank online banking transfer vertical:',
  '- Service: `app/services/verticals/webster.js`',
  '- Route: `app/routes/verticals/webster.js`',
  '- Page: `app/public/verticals/webster.html` (served at `/webster`)',
  '',
  'Start from the account the customer transferred from and work back through',
  'the transfer fee schedule its product code resolves to.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

/**
 * Deposit accounts shown on the account summary. `productCode` comes from the
 * core banking system of record.
 */
const ACCOUNTS = [
  {
    id: 'WBS-CHK-6604', name: 'Private Client Checking', productCode: 'santander_private', balance: 18642.37, currency: 'USD',
  },
  {
    id: 'WBS-SAV-3315', name: 'Premier Money Market Savings', productCode: 'premier', balance: 96210.44, currency: 'USD',
  },
  {
    id: 'WBS-VAL-1187', name: 'Value Checking', productCode: 'value', balance: 2384.19, currency: 'USD',
  },
];

/**
 * External accounts linked for outbound transfers.
 */
const EXTERNAL_ACCOUNTS = [
  { id: 'EXT-CHASE-4921', name: 'Chase Total Checking ••4921' },
];

/**
 * Recent activity shown on the account summary.
 */
const TRANSACTIONS = [
  {
    id: 'TXN-5101', date: '2026-10-09', description: 'Direct Deposit — Yale New Haven Health', amount: 4218.55, type: 'credit', account: 'WBS-CHK-6604',
  },
  {
    id: 'TXN-5102', date: '2026-10-08', description: 'Stop & Shop #0612 Waterbury CT', amount: -142.87, type: 'debit', account: 'WBS-CHK-6604',
  },
  {
    id: 'TXN-5103', date: '2026-10-07', description: 'Eversource Energy', amount: -186.32, type: 'debit', account: 'WBS-CHK-6604',
  },
  {
    id: 'TXN-5104', date: '2026-10-05', description: 'Zelle® to Michael Russo', amount: -250.00, type: 'transfer', account: 'WBS-CHK-6604',
  },
  {
    id: 'TXN-5105', date: '2026-09-30', description: 'Interest Paid — Premier Money Market', amount: 312.08, type: 'credit', account: 'WBS-SAV-3315',
  },
];

/**
 * Transfer fee schedules by deposit product code.
 */
const FEE_SCHEDULES = {
  private_client: { rate: 0, flat: 0 },
  premier: { rate: 0, flat: 0 },
  value: { rate: 0.001, flat: 3.00 },
};

function findAccount(id) {
  return ACCOUNTS.find((a) => a.id === id);
}

function isKnownDestination(id) {
  return Boolean(findAccount(id)) || EXTERNAL_ACCOUNTS.some((a) => a.id === id);
}

/**
 * Look up the transfer fee schedule for a deposit product code.
 */
function resolveFeeSchedule(productCode) {
  return FEE_SCHEDULES[productCode];
}

/**
 * Calculate the transfer fee for the source account.
 */
function calculateTransferFee(account, amount) {
  const schedule = resolveFeeSchedule(account.productCode);
  return Math.max(schedule.rate * amount, schedule.flat);
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function validateTransfer(data) {
  const from = findAccount(data.fromAccount);
  if (!from) throw new ValidationError('Select an account to transfer from.');
  if (!isKnownDestination(data.toAccount)) throw new ValidationError('Select an account to transfer to.');
  if (data.fromAccount === data.toAccount) throw new ValidationError('Choose two different accounts.');
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Enter an amount greater than $0.00.');
  if (amount > from.balance) throw new ValidationError('The amount exceeds the available balance.');
  return { from, amount: roundCents(amount) };
}

/**
 * Process a transfer from a Webster deposit account.
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();
  const { from, amount } = validateTransfer(data);

  logger.info('Processing Webster transfer', {
    transferId,
    fromAccount: data.fromAccount,
    toAccount: data.toAccount,
    amount,
    productCode: from.productCode,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const fee = roundCents(calculateTransferFee(from, amount));
    const totalDebit = roundCents(amount + fee);
    const duration = Date.now() - startTime;

    incrementMetric('webster_transfer.success', { route: ROUTE, productCode: from.productCode });
    recordTiming('webster_transfer.latency', duration, { route: ROUTE });

    return {
      success: true,
      transferId,
      status: 'completed',
      receipt: {
        confirmationNumber: `WBS${Date.now().toString().slice(-9)}`,
        from: data.fromAccount,
        to: data.toAccount,
        amount: amount.toFixed(2),
        fee: fee.toFixed(2),
        totalDebit: totalDebit.toFixed(2),
        timestamp: new Date().toISOString(),
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('webster_transfer.failure', {
      route: ROUTE,
      errorClass: error.name,
      productCode: from.productCode,
    });
    recordTiming('webster_transfer.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Webster transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      toAccount: data.toAccount,
      productCode: from.productCode,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, productCode: from.productCode, page: PAGE,
      },
      extra: {
        transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/webster.js — calculateTransferFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      // On-call and the Devin session both resolve from the demo user's
      // devindemos.com identity — no hard-coded Slack member here.
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Webster Bank Online Banking — Transfer',
      customer: 'webster',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'productCode', value: from.productCode },
        { key: 'page', value: PAGE },
      ],
      extra: {
        transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'webster-online-banking@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Webster transfer error', { error: err.message });
    });

    error.transferId = transferId;
    throw error;
  }
}

module.exports = {
  processTransfer,
  ValidationError,
  ACCOUNTS,
  EXTERNAL_ACCOUNTS,
  TRANSACTIONS,
  FEE_SCHEDULES,
  REMEDIATION_DIRECTIVE,
};
