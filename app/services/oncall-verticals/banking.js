const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { getScopedConfig } = require('../../incidentModes');
const COMPLIANCE_CONFIG = require('../../../config/oncall-compliance').banking;

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
 * window before funds move. `daysAgo` positions each transaction relative to
 * today; the compliance config's screeningWindowDays selects how far back
 * screening reaches.
 */
const ACCOUNT_HISTORY = [
  { id: 'TXN-001', daysAgo: 1, description: 'Direct Deposit - Payroll', amount: 3250.00, counterparty: 'ADP Payroll' },
  { id: 'TXN-002', daysAgo: 2, description: 'Electric Company', amount: -142.30, counterparty: 'City Power & Light' },
  { id: 'TXN-003', daysAgo: 3, description: 'Grocery Store', amount: -87.52, counterparty: 'FreshMart' },
  { id: 'TXN-004', daysAgo: 4, description: 'Transfer to Savings', amount: -500.00, counterparty: 'Internal' },
  { id: 'TXN-005', daysAgo: 4, description: 'Transfer from Checking', amount: 500.00, counterparty: 'Internal' },
  { id: 'TXN-006', daysAgo: 5, description: 'Online Purchase', amount: -249.99, counterparty: 'WebRetailer' },
  { id: 'TXN-007', daysAgo: 6, description: 'ATM Withdrawal', amount: -200.00, counterparty: 'ATM-4415' },
  { id: 'TXN-008', daysAgo: 7, description: 'Wire In - Invoice 8841', amount: 5120.00, counterparty: 'Northline LLC' },
  { id: 'TXN-009', daysAgo: 9, description: 'Card Payment', amount: -68.14, counterparty: 'CoffeeCo' },
  { id: 'TXN-010', daysAgo: 12, description: 'Subscription', amount: -14.99, counterparty: 'StreamPlus' },
  { id: 'TXN-011', daysAgo: 14, description: 'Card Payment', amount: -132.40, counterparty: 'AirWays' },
  { id: 'TXN-012', daysAgo: 16, description: 'Check Deposit', amount: 890.00, counterparty: 'Check 1042' },
  { id: 'TXN-013', daysAgo: 18, description: 'Mortgage Payment', amount: -2140.00, counterparty: 'HomeTrust Lending' },
  { id: 'TXN-014', daysAgo: 20, description: 'Card Payment', amount: -54.20, counterparty: 'BooksNow' },
  { id: 'TXN-015', daysAgo: 22, description: 'Direct Deposit - Payroll', amount: 3250.00, counterparty: 'ADP Payroll' },
  { id: 'TXN-016', daysAgo: 25, description: 'Insurance Premium', amount: -212.75, counterparty: 'Shield Mutual' },
  { id: 'TXN-017', daysAgo: 27, description: 'Grocery Store', amount: -104.61, counterparty: 'FreshMart' },
  { id: 'TXN-018', daysAgo: 30, description: 'Wire Out - Invoice 9102', amount: -1875.00, counterparty: 'Corewell Supplies' },
  { id: 'TXN-019', daysAgo: 33, description: 'ATM Withdrawal', amount: -300.00, counterparty: 'ATM-2210' },
  { id: 'TXN-020', daysAgo: 36, description: 'Card Payment', amount: -89.99, counterparty: 'GadgetHub' },
  { id: 'TXN-021', daysAgo: 38, description: 'Direct Deposit - Payroll', amount: 3250.00, counterparty: 'ADP Payroll' },
  { id: 'TXN-022', daysAgo: 41, description: 'Utility Payment', amount: -96.40, counterparty: 'Metro Water' },
  { id: 'TXN-023', daysAgo: 44, description: 'Transfer to Savings', amount: -750.00, counterparty: 'Internal' },
  { id: 'TXN-024', daysAgo: 47, description: 'Card Payment', amount: -42.10, counterparty: 'CoffeeCo' },
  { id: 'TXN-025', daysAgo: 50, description: 'Check Deposit', amount: 1260.00, counterparty: 'Check 1043' },
  { id: 'TXN-026', daysAgo: 53, description: 'Subscription', amount: -14.99, counterparty: 'StreamPlus' },
  { id: 'TXN-027', daysAgo: 56, description: 'Wire In - Invoice 8790', amount: 4480.00, counterparty: 'Northline LLC' },
  { id: 'TXN-028', daysAgo: 60, description: 'Card Payment', amount: -156.30, counterparty: 'AirWays' },
  { id: 'TXN-029', daysAgo: 63, description: 'Grocery Store', amount: -93.77, counterparty: 'FreshMart' },
  { id: 'TXN-030', daysAgo: 67, description: 'Direct Deposit - Payroll', amount: 3250.00, counterparty: 'ADP Payroll' },
  { id: 'TXN-031', daysAgo: 70, description: 'Mortgage Payment', amount: -2140.00, counterparty: 'HomeTrust Lending' },
  { id: 'TXN-032', daysAgo: 74, description: 'Online Purchase', amount: -319.49, counterparty: 'WebRetailer' },
  { id: 'TXN-033', daysAgo: 78, description: 'ATM Withdrawal', amount: -200.00, counterparty: 'ATM-4415' },
  { id: 'TXN-034', daysAgo: 82, description: 'Insurance Premium', amount: -212.75, counterparty: 'Shield Mutual' },
  { id: 'TXN-035', daysAgo: 86, description: 'Card Payment', amount: -61.05, counterparty: 'BooksNow' },
  { id: 'TXN-036', daysAgo: 89, description: 'Utility Payment', amount: -101.88, counterparty: 'Metro Water' },
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
 * Effective compliance parameters: the shipped config, with any per-run
 * override registered for the caller's on-call run applied on top.
 */
function effectiveComplianceConfig() {
  const override = getScopedConfig();
  return {
    screeningWindowDays: Number(override.screeningWindowDays) > 0
      ? Number(override.screeningWindowDays)
      : COMPLIANCE_CONFIG.screeningWindowDays,
    screeningConcurrency: Number(override.screeningConcurrency) > 0
      ? Number(override.screeningConcurrency)
      : Math.max(1, Math.floor(COMPLIANCE_CONFIG.screeningConcurrency) || 1),
  };
}

/**
 * Screen a single historical transaction against the sanctions watchlist.
 * Round-trips to the screening partner (p50 ~250ms).
 */
async function screenTransaction(txn) {
  await new Promise((resolve) => setTimeout(resolve, 180 + Math.random() * 140));
  return { txnId: txn.id, counterparty: txn.counterparty, cleared: true };
}

/**
 * Run AML screening over the sender's recent activity window.
 * Every transaction in the window must clear before the transfer proceeds.
 *
 * Premium accounts are enrolled in the pre-cleared counterparty program:
 * their counterparties are re-screened out of band every night, so the
 * transfer path only performs a cache check.
 *
 * For other tiers, the screened window is bounded by screeningWindowDays and
 * partner calls run in batches of screeningConcurrency.
 */
async function runComplianceScreening(fromAccount, accountTier) {
  const tierKey = String(accountTier || '').toLowerCase();
  if (tierKey === 'premium') {
    await new Promise((resolve) => setTimeout(resolve, 25 + Math.random() * 25));
    return { account: fromAccount, screened: 0, cleared: true, preCleared: true };
  }

  const { screeningWindowDays, screeningConcurrency } = effectiveComplianceConfig();
  const window = ACCOUNT_HISTORY.filter((txn) => txn.daysAgo <= screeningWindowDays);
  const results = [];
  for (let i = 0; i < window.length; i += screeningConcurrency) {
    const batch = window.slice(i, i + screeningConcurrency);
    results.push(...await Promise.all(batch.map((txn) => screenTransaction(txn))));
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
async function processTransfer(data, options = {}) {
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
    await runComplianceScreening(data.fromAccount, data.accountTier);

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
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount },
    });

    throw error;
  }
}

module.exports = { processTransfer, ACCOUNTS };
