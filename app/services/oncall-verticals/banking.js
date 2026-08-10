const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { getScopedConfig } = require('../../incidentModes');

/**
 * Compliance screening parameters — operational settings owned by the ops
 * runtime environment (SCREENING_WINDOW_DAYS / SCREENING_CONCURRENCY).
 */
const COMPLIANCE_CONFIG = {
  screeningWindowDays: Number(process.env.SCREENING_WINDOW_DAYS) > 0
    ? Number(process.env.SCREENING_WINDOW_DAYS)
    : 90,
  screeningConcurrency: Number(process.env.SCREENING_CONCURRENCY) > 0
    ? Math.max(1, Math.floor(Number(process.env.SCREENING_CONCURRENCY)))
    : 1,
};

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
 * Recent account activity. `daysAgo` positions each transaction relative to
 * today.
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
 * Payments gateway submission policy. Timeout and backoff were raised after
 * the gateway brownouts in June (PAY-3311); retries are capped at 3 attempts
 * per transfer.
 */
const GATEWAY_RETRY_POLICY = {
  maxAttempts: 3,
  timeoutMs: 4000,
  backoffMs: 750,
};

/**
 * Fraud velocity model parameters. Cache TTL was dropped to 500ms after the
 * stale-score incident (FRAUD-207) — effectively every transfer rescoring
 * from scratch until the model team ships v3.
 */
const RISK_MODEL = {
  version: 'v2',
  velocityLookbackDays: 30,
  cacheTtlMs: 500,
};
const RISK_CACHE_MAX_ENTRIES = 500;
const riskScoreCache = new Map();

// Transient-failure rates observed on the gateway's settlement endpoint.
// Synthetic-monitor traffic is routed through the gateway's canary pool,
// which has been flakier since the June brownouts (PAY-3311).
const GATEWAY_TRANSIENT_FAILURE_RATE = 0.002;
const GATEWAY_SYNTHETIC_FAILURE_RATE = 0.08;

/**
 * Transfer fee tiers by account type
 */
const FEE_TIERS = {
  premium:  { rate: 0, flat: 0 },
  standard: { rate: 0.001, flat: 2.50 },
  basic:    { rate: 0.002, flat: 4.99 },
};

/**
 * Effective compliance parameters for this request.
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
 */
async function screenTransaction(txn) {
  await new Promise((resolve) => setTimeout(resolve, 180 + Math.random() * 140));
  return { txnId: txn.id, counterparty: txn.counterparty, cleared: true };
}

/**
 * Run AML screening over the sender's recent activity window. Every
 * transaction in the window must clear before the transfer proceeds.
 * Premium accounts use the pre-cleared counterparty cache path.
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
 * Score transfer velocity against the sender's recent activity. Applies to
 * every tier — fraud rules do not exempt premium accounts.
 */
async function scoreTransferRisk(fromAccount, amount) {
  const cacheKey = `${fromAccount}:${Number(amount) || 0}:${RISK_MODEL.version}`;
  const cached = riskScoreCache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.at < RISK_MODEL.cacheTtlMs) return cached.score;
    riskScoreCache.delete(cacheKey);
  }
  const window = ACCOUNT_HISTORY.filter((txn) => txn.daysAgo <= RISK_MODEL.velocityLookbackDays);
  await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 20));
  const outflow = window.reduce((sum, txn) => sum + (txn.amount < 0 ? -txn.amount : 0), 0);
  const score = Math.min(0.99, (Number(amount) || 0) / Math.max(outflow, 1));
  if (riskScoreCache.size >= RISK_CACHE_MAX_ENTRIES) {
    riskScoreCache.delete(riskScoreCache.keys().next().value);
  }
  riskScoreCache.set(cacheKey, { score, at: Date.now() });
  return score;
}

/**
 * Submit the transfer to the payments gateway for settlement, retrying per
 * GATEWAY_RETRY_POLICY on transient failures.
 */
async function submitToPaymentsGateway(transfer, { synthetic = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= GATEWAY_RETRY_POLICY.maxAttempts; attempt++) {
    // The canary pool's flakiness shows up as first-attempt timeouts; retries
    // land on the stable pool, so settlements virtually never exhaust the
    // retry budget.
    const failureRate = synthetic && attempt === 1
      ? GATEWAY_SYNTHETIC_FAILURE_RATE
      : GATEWAY_TRANSIENT_FAILURE_RATE;
    try {
      await new Promise((resolve, reject) => setTimeout(() => {
        if (Math.random() < failureRate) {
          reject(Object.assign(new Error('gateway settlement timeout'), { code: 'GATEWAY_TIMEOUT' }));
          return;
        }
        resolve();
      }, 40 + Math.random() * 40));
      return { gatewayRef: `GW-${transfer.fromAccount}-${Date.now()}`, attempt };
    } catch (error) {
      lastError = error;
      if (attempt < GATEWAY_RETRY_POLICY.maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, GATEWAY_RETRY_POLICY.backoffMs * attempt));
      }
    }
  }
  throw lastError;
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
    const stepStart1 = Date.now();
    await scoreTransferRisk(data.fromAccount, data.amount);
    const riskMs = Date.now() - stepStart1;

    const stepStart2 = Date.now();
    await runComplianceScreening(data.fromAccount, data.accountTier);
    const screeningMs = Date.now() - stepStart2;

    const stepStart3 = Date.now();
    await submitToPaymentsGateway(data, { synthetic: Boolean(options.synthetic) });
    const gatewayMs = Date.now() - stepStart3;

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
      ...(options.debugTimings ? { stepTimings: { riskMs, screeningMs, gatewayMs } } : {}),
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

module.exports = { processTransfer, ACCOUNTS, COMPLIANCE_CONFIG };
