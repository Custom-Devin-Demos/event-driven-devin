const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Bank accounts for the demo
 */
const ACCOUNTS = [
  { id: 'ACCT-1001', name: 'Checking', type: 'premium', balance: 25430.00, currency: 'USD' },
  { id: 'ACCT-1002', name: 'Savings', type: 'standard', balance: 84210.50, currency: 'USD' },
  { id: 'ACCT-1003', name: 'Money Market', type: 'basic', balance: 12750.00, currency: 'USD' },
  { id: 'ACCT-1004', name: 'Business Checking', type: 'premium', balance: 156200.00, currency: 'USD' },
];

/**
 * Recent transactions for display
 */
const TRANSACTIONS = [
  { id: 'TXN-001', date: '2026-03-15', description: 'Direct Deposit - Payroll', amount: 3250.00, type: 'credit', account: 'ACCT-1001' },
  { id: 'TXN-002', date: '2026-03-14', description: 'Electric Company', amount: -142.30, type: 'debit', account: 'ACCT-1001' },
  { id: 'TXN-003', date: '2026-03-13', description: 'Grocery Store', amount: -87.52, type: 'debit', account: 'ACCT-1001' },
  { id: 'TXN-004', date: '2026-03-12', description: 'Transfer to Savings', amount: -500.00, type: 'transfer', account: 'ACCT-1001' },
  { id: 'TXN-005', date: '2026-03-12', description: 'Transfer from Checking', amount: 500.00, type: 'transfer', account: 'ACCT-1002' },
  { id: 'TXN-006', date: '2026-03-10', description: 'Online Purchase', amount: -249.99, type: 'debit', account: 'ACCT-1001' },
];

/**
 * Transfer fee tiers by account type
 */
const FEE_TIERS = {
  premium:  { rate: 0, flat: 0 },
  standard: { rate: 0.001, flat: 2.50 },
  basic:    { rate: 0.002, flat: 4.99 },
};

/**
 * Resolve the fee structure for a given account tier.
 */
async function resolveFeeTier(accountTier) {
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
    receiptId: `RCP-${Date.now()}`,
    from: transfer.fromAccount,
    to: transfer.toAccount,
    amount: transfer.amount,
    fee: feeBreakdown.fee.toFixed(2),
    totalDebit: feeBreakdown.totalDebit.toFixed(2),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a fund transfer between accounts.
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Processing transfer', {
    transferId,
    fromAccount: data.fromAccount,
    toAccount: data.toAccount,
    amount: data.amount,
    service: 'banking-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const tierData = resolveFeeTier(data.accountTier);
    const fee = calculateTransferFee(tierData, data.amount);
    const totalDebit = data.amount + fee;
    const receipt = formatReceipt(data, { fee, totalDebit });

    const duration = Date.now() - startTime;

    incrementMetric('transfer.success', {
      route: '/api/banking/transfer',
      accountTier: data.accountTier,
    });
    recordTiming('transfer.latency', duration, {
      route: '/api/banking/transfer',
    });

    return {
      success: true,
      transferId,
      receipt,
      status: 'completed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('transfer.failure', {
      route: '/api/banking/transfer',
      errorClass: error.name,
      accountTier: data.accountTier,
    });
    recordTiming('transfer.latency', duration, {
      route: '/api/banking/transfer',
      error: 'true',
    });

    logger.error('Transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      toAccount: data.toAccount,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/banking/transfer',
        service: 'banking-api',
        accountTier: data.accountTier,
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
      culprit: 'app/services/verticals/banking.js — processTransfer',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'banking-api',
      verticalLabel: 'Banking Transfer',
      tags: [
        { key: 'route', value: '/api/banking/transfer' },
        { key: 'service', value: 'banking-api' },
        { key: 'accountTier', value: data.accountTier },
      ],
      extra: { transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'apex-bank@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from transfer error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processTransfer, ACCOUNTS, TRANSACTIONS };
