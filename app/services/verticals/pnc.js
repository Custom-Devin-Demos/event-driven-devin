const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'pnc-transfers-api';
const ROUTE = '/api/pnc/transfer';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the PNC online banking transfer vertical:',
  '- Service: `app/services/verticals/pnc.js`',
  '- Route: `app/routes/verticals/pnc.js`',
  '- Page: `app/public/verticals/pnc.html` (served at `/pnc`)',
  '',
  'Start from the transfer the customer submitted and work back through the',
  'fee schedule the account tier resolves to.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Virtual Wallet accounts shown on the account summary.
 */
const ACCOUNTS = [
  {
    id: 'PNC-SPEND-4417', name: 'Virtual Wallet Spend', tier: 'performance', balance: 8425.63, currency: 'USD',
  },
  {
    id: 'PNC-RESERVE-2208', name: 'Virtual Wallet Reserve', tier: 'standard', balance: 3180.00, currency: 'USD',
  },
  {
    id: 'PNC-GROWTH-9361', name: 'Virtual Wallet Growth', tier: 'select', balance: 41250.75, currency: 'USD',
  },
];

/**
 * Recent activity shown on the account summary.
 */
const TRANSACTIONS = [
  {
    id: 'TXN-8801', date: '2026-03-16', description: 'Direct Deposit — Payroll', amount: 3412.88, type: 'credit', account: 'PNC-SPEND-4417',
  },
  {
    id: 'TXN-8802', date: '2026-03-15', description: 'Giant Eagle #4411', amount: -164.22, type: 'debit', account: 'PNC-SPEND-4417',
  },
  {
    id: 'TXN-8803', date: '2026-03-14', description: 'Duquesne Light', amount: -118.40, type: 'debit', account: 'PNC-SPEND-4417',
  },
  {
    id: 'TXN-8804', date: '2026-03-13', description: 'Transfer to Reserve', amount: -600.00, type: 'transfer', account: 'PNC-SPEND-4417',
  },
  {
    id: 'TXN-8805', date: '2026-03-12', description: 'PNC Points Statement Credit', amount: 45.00, type: 'credit', account: 'PNC-SPEND-4417',
  },
];

/**
 * Transfer fee schedules by Virtual Wallet account tier.
 */
const FEE_TIERS = {
  performance: { rate: 0, flat: 0 },
  standard: { rate: 0.001, flat: 2.50 },
  select: { rate: 0.002, flat: 4.99 },
};

/**
 * Resolve the fee structure for a given account tier.
 */
function resolveFeeTier(accountTier) {
  const tier = FEE_TIERS[accountTier];
  if (!tier) return null;
  return { params: [tier.rate, tier.flat] };
}

/**
 * Calculate the transfer fee from the resolved tier data.
 */
function calculateTransferFee(tierData, amount) {
  const baseFee = tierData.schedule.rate * amount;
  const minimumFee = tierData.schedule.flat;
  return Math.max(baseFee, minimumFee);
}

/**
 * Format a transfer receipt for the response.
 */
function formatReceipt(transfer, feeBreakdown) {
  return {
    receiptId: `PNC-${Date.now()}`,
    from: transfer.fromAccount,
    to: transfer.toAccount,
    amount: transfer.amount,
    fee: feeBreakdown.fee.toFixed(2),
    totalDebit: feeBreakdown.totalDebit.toFixed(2),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a transfer between two Virtual Wallet accounts.
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Processing PNC transfer', {
    transferId,
    fromAccount: data.fromAccount,
    toAccount: data.toAccount,
    amount: data.amount,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const tierData = resolveFeeTier(data.accountTier);
    const fee = calculateTransferFee(tierData, data.amount);
    const totalDebit = data.amount + fee;
    const receipt = formatReceipt(data, { fee, totalDebit });

    const duration = Date.now() - startTime;

    incrementMetric('pnc_transfer.success', { route: ROUTE, accountTier: data.accountTier });
    recordTiming('pnc_transfer.latency', duration, { route: ROUTE });

    return {
      success: true,
      transferId,
      receipt,
      status: 'completed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('pnc_transfer.failure', {
      route: ROUTE,
      errorClass: error.name,
      accountTier: data.accountTier,
    });
    recordTiming('pnc_transfer.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('PNC transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      toAccount: data.toAccount,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, accountTier: data.accountTier, page: '/pnc',
      },
      extra: {
        transferId,
        fromAccount: data.fromAccount,
        toAccount: data.toAccount,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/pnc.js — processTransfer',
      errorType: error.name || 'Error',
      errorValue: error.message,
      // On-call and the Devin session both resolve from the demo user's
      // devindemos.com identity — no hard-coded Slack member here.
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'PNC Online Banking — Transfer',
      customer: 'pnc',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'accountTier', value: data.accountTier },
        { key: 'page', value: '/pnc' },
      ],
      extra: {
        transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'pnc-online-banking@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from PNC transfer error', { error: err.message });
    });

    error.transferId = transferId;
    throw error;
  }
}

module.exports = {
  processTransfer,
  ACCOUNTS,
  TRANSACTIONS,
  FEE_TIERS,
  REMEDIATION_DIRECTIVE,
};
