const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Bank accounts for the Scotiabank demo
 */
const ACCOUNTS = [
  { id: 'ACCT-CHQ-4901', name: 'Ultimate Chequing', type: 'ultimate', balance: 18425.30, currency: 'CAD' },
  { id: 'ACCT-SAV-4902', name: 'Momentum PLUS Savings', type: 'savings', balance: 67810.00, currency: 'CAD' },
  { id: 'ACCT-CHQ-4903', name: 'Preferred Chequing', type: 'preferred', balance: 5420.15, currency: 'CAD' },
  { id: 'ACCT-TFSA-4904', name: 'TFSA Savings', type: 'registered', balance: 34500.00, currency: 'CAD' },
];

/**
 * Recent transactions for display
 */
const TRANSACTIONS = [
  { id: 'TXN-001', date: '2026-06-20', description: 'Direct Deposit - Payroll', amount: 3875.00, type: 'credit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-002', date: '2026-06-19', description: 'Interac e-Transfer - Sarah M.', amount: -150.00, type: 'debit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-003', date: '2026-06-18', description: 'Loblaws #4421', amount: -98.72, type: 'debit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-004', date: '2026-06-17', description: 'Scene+ Redemption - Cineplex', amount: 12.50, type: 'credit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-005', date: '2026-06-15', description: 'Hydro One - Utilities', amount: -134.20, type: 'debit', account: 'ACCT-CHQ-4901' },
];

/**
 * e-Transfer fee schedule by account package.
 * NOTE: The "ultimate" package has feeSchedule explicitly set to null
 * because it includes unlimited free e-Transfers — the fee calculation
 * should short-circuit before accessing schedule properties. However,
 * the calculateFee function accesses .perTransaction unconditionally.
 */
const PACKAGE_FEES = {
  ultimate:  { monthlyFee: 30.95, feeSchedule: null },
  preferred: { monthlyFee: 16.95, feeSchedule: { perTransaction: 1.50, dailyLimit: 3000 } },
  basic:     { monthlyFee: 4.95,  feeSchedule: { perTransaction: 1.50, dailyLimit: 1000 } },
};

/**
 * Resolve the fee package for the given account type.
 */
function resolvePackage(accountType) {
  const pkg = PACKAGE_FEES[accountType];
  if (!pkg) return null;
  return { config: pkg };
}

/**
 * Calculate the e-Transfer fee.
 * BUG: For "ultimate" accounts, feeSchedule is null because transfers
 * are free. Accessing .perTransaction on null crashes with TypeError.
 */
function calculateFee(packageData, _amount) {
  const fee = packageData.config.feeSchedule.perTransaction;
  return fee > 0 ? fee : 0;
}

/**
 * Build the e-Transfer confirmation receipt.
 */
function buildReceipt(transferData, fee) {
  const totalDebit = transferData.amount + fee;
  return {
    receiptId: `SCO-${Date.now()}`,
    from: transferData.fromAccount,
    recipient: transferData.recipient,
    amount: transferData.amount,
    fee: fee.toFixed(2),
    debitAmount: totalDebit.toFixed(2),
    timestamp: new Date().toISOString(),
    method: 'Interac e-Transfer',
  };
}

/**
 * Process an Interac e-Transfer.
 */
async function processETransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Processing Interac e-Transfer', {
    transferId,
    fromAccount: data.fromAccount,
    recipient: data.recipient,
    amount: data.amount,
    service: 'scotiabank-etransfer',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const packageData = resolvePackage(data.accountType);
    const fee = calculateFee(packageData, data.amount);
    const receipt = buildReceipt(data, fee);

    const duration = Date.now() - startTime;

    incrementMetric('etransfer.success', {
      route: '/api/scotiabank/etransfer',
      accountType: data.accountType,
    });
    recordTiming('etransfer.latency', duration, {
      route: '/api/scotiabank/etransfer',
    });

    return {
      success: true,
      transferId,
      receipt,
      status: 'sent',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('etransfer.failure', {
      route: '/api/scotiabank/etransfer',
      errorClass: error.name,
      accountType: data.accountType,
    });
    recordTiming('etransfer.latency', duration, {
      route: '/api/scotiabank/etransfer',
      error: 'true',
    });

    logger.error('Interac e-Transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      recipient: data.recipient,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/scotiabank/etransfer',
        service: 'scotiabank-etransfer',
        accountType: data.accountType,
      },
      extra: {
        transferId,
        fromAccount: data.fromAccount,
        recipient: data.recipient,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/scotiabank.js \u2014 calculateFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'scotiabank-etransfer',
      verticalLabel: 'Scotiabank e-Transfer',
      customer: 'scotiabank',
      tags: [
        { key: 'route', value: '/api/scotiabank/etransfer' },
        { key: 'service', value: 'scotiabank-etransfer' },
        { key: 'accountType', value: data.accountType },
      ],
      extra: { transferId, fromAccount: data.fromAccount, recipient: data.recipient, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'scotiabank-etransfer@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from e-Transfer error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processETransfer, ACCOUNTS, TRANSACTIONS };
