const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

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
 * Recent transactions considered by compliance screening. AML rules require
 * every outgoing transfer to be screened against the sender's recent activity
 * window before funds move.
 */
const SCREENING_WINDOW = [
  { id: 'TXN-001', date: '2026-03-15', description: 'Direct Deposit - Payroll', amount: 3250.00, counterparty: 'ADP Payroll' },
  { id: 'TXN-002', date: '2026-03-14', description: 'Electric Company', amount: -142.30, counterparty: 'City Power & Light' },
  { id: 'TXN-003', date: '2026-03-13', description: 'Grocery Store', amount: -87.52, counterparty: 'FreshMart' },
  { id: 'TXN-004', date: '2026-03-12', description: 'Transfer to Savings', amount: -500.00, counterparty: 'Internal' },
  { id: 'TXN-005', date: '2026-03-12', description: 'Transfer from Checking', amount: 500.00, counterparty: 'Internal' },
  { id: 'TXN-006', date: '2026-03-10', description: 'Online Purchase', amount: -249.99, counterparty: 'WebRetailer' },
  { id: 'TXN-007', date: '2026-03-09', description: 'ATM Withdrawal', amount: -200.00, counterparty: 'ATM-4415' },
  { id: 'TXN-008', date: '2026-03-08', description: 'Wire In - Invoice 8841', amount: 5120.00, counterparty: 'Northline LLC' },
  { id: 'TXN-009', date: '2026-03-07', description: 'Card Payment', amount: -68.14, counterparty: 'CoffeeCo' },
  { id: 'TXN-010', date: '2026-03-06', description: 'Subscription', amount: -14.99, counterparty: 'StreamPlus' },
  { id: 'TXN-011', date: '2026-03-05', description: 'Card Payment', amount: -132.40, counterparty: 'AirWays' },
  { id: 'TXN-012', date: '2026-03-04', description: 'Check Deposit', amount: 890.00, counterparty: 'Check 1042' },
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
 * Screen a single historical transaction against the sanctions watchlist.
 * Round-trips to the screening partner (p50 ~700ms).
 */
async function screenTransaction(txn) {
  await new Promise((resolve) => setTimeout(resolve, 650 + Math.random() * 200));
  return { txnId: txn.id, counterparty: txn.counterparty, cleared: true };
}

/**
 * Run AML screening over the sender's recent activity window.
 * Every transaction in the window must clear before the transfer proceeds.
 */
async function runComplianceScreening(fromAccount) {
  const results = [];
  for (const txn of SCREENING_WINDOW) {
    results.push(await screenTransaction(txn));
  }
  return { account: fromAccount, screened: results.length, cleared: results.every((r) => r.cleared) };
}

/**
 * Resolve the fee structure for a given account tier.
 */
function resolveFeeTier(accountTier) {
  const key = String(accountTier || '').toLowerCase();
  return FEE_TIERS[key] || FEE_TIERS.standard;
}

/**
 * Calculate the transfer fee from the resolved tier data.
 */
function calculateTransferFee(tier, amount) {
  const baseFee = tier.rate * amount;
  const minimumFee = tier.flat;
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
    route: '/api/oncall/banking/transfer',
  });

  try {
    const screening = await runComplianceScreening(data.fromAccount);

    const tier = resolveFeeTier(data.accountTier);
    const fee = calculateTransferFee(tier, data.amount);
    const totalDebit = data.amount + fee;
    const receipt = formatReceipt(data, { fee, totalDebit });

    const duration = Date.now() - startTime;

    incrementMetric('transfer.success', {
      route: '/api/oncall/banking/transfer',
      accountTier: data.accountTier,
    });
    recordTiming('transfer.latency', duration, {
      route: '/api/oncall/banking/transfer',
    });

    logger.info('Transfer completed', {
      transferId,
      durationMs: duration,
      screenedTransactions: screening.screened,
      service: 'banking-api',
    });

    return {
      success: true,
      transferId,
      receipt,
      fee: fee.toFixed(2),
      debitAmount: totalDebit.toFixed(2),
      status: 'completed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('transfer.failure', {
      route: '/api/oncall/banking/transfer',
      errorClass: error.name,
      accountTier: data.accountTier,
    });
    recordTiming('transfer.latency', duration, {
      route: '/api/oncall/banking/transfer',
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
        route: '/api/oncall/banking/transfer',
        service: 'banking-api',
        accountTier: data.accountTier,
      },
      extra: { transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount },
    });

    throw error;
  }
}

module.exports = { processTransfer, ACCOUNTS };
