const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Bank accounts for the Scotiabank demo.
 * Balances in Canadian dollars (CAD).
 */
const ACCOUNTS = [
  { id: 'ACCT-CHQ-4901', name: 'Ultimate Chequing', type: 'chequing', balance: 18425.30, currency: 'CAD' },
  { id: 'ACCT-CHQ-4903', name: 'Preferred Chequing', type: 'chequing', balance: 5420.15, currency: 'CAD' },
  { id: 'ACCT-SAV-4902', name: 'Momentum PLUS Savings', type: 'savings', balance: 67810.00, currency: 'CAD' },
  { id: 'CC-VISA-7741', name: 'Scotiabank Visa Infinite', type: 'credit', balance: -612.30, currency: 'CAD' },
];

/**
 * Frequent recipients (transfers to third parties).
 */
const RECIPIENTS = [
  { id: 'REC-1001', name: 'Sarah Mitchell', email: 'sarah.m@email.ca', bank: 'Scotiabank', account: 'ACCT-CHQ-9920', transferType: 'same-institution' },
  { id: 'REC-1002', name: 'Michael Chen', email: 'michael.chen@email.ca', bank: 'RBC Royal Bank', account: 'ACCT-CHQ-4471', transferType: 'interac' },
  { id: 'REC-1003', name: 'Priya Sharma', email: 'priya.sharma@email.ca', bank: 'TD Canada Trust', account: 'ACCT-CHQ-3380', transferType: 'interac' },
  { id: 'REC-1004', name: 'David Tremblay', email: 'david.t@email.ca', bank: 'Scotiabank', account: 'ACCT-SAV-2261', transferType: 'same-institution' },
];

/**
 * Recent transactions for display on the dashboard.
 */
const TRANSACTIONS = [
  { id: 'TXN-001', date: '2026-06-22', description: 'Direct Deposit - Payroll', amount: 3875.00, type: 'credit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-002', date: '2026-06-21', description: 'Interac e-Transfer - Sarah Mitchell', amount: -150.00, type: 'debit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-003', date: '2026-06-20', description: 'Loblaws #4421', amount: -98.72, type: 'debit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-004', date: '2026-06-19', description: 'Hydro One - Utilities', amount: -134.20, type: 'debit', account: 'ACCT-CHQ-4901' },
  { id: 'TXN-005', date: '2026-06-18', description: 'Scene+ Redemption - Cineplex', amount: 12.50, type: 'credit', account: 'ACCT-CHQ-4901' },
];

/**
 * Transfer fee schedule by account package.
 * NOTE: The "ultimate" package has feeSchedule explicitly set to null
 * because it includes unlimited free transfers — the fee calculation
 * should short-circuit before accessing schedule properties. However,
 * calculateFee reads .interacFee unconditionally.
 */
const PACKAGE_FEES = {
  ultimate:  { monthlyFee: 30.95, feeSchedule: null },
  preferred: { monthlyFee: 16.95, feeSchedule: { interacFee: 1.50, sameInstitutionFee: 0, dailyLimit: 3000 } },
  basic:     { monthlyFee: 4.95,  feeSchedule: { interacFee: 1.50, sameInstitutionFee: 0, dailyLimit: 1000 } },
};

/**
 * Resolve the fee package for the given account package.
 */
function resolvePackage(pkg) {
  const config = PACKAGE_FEES[pkg];
  if (!config) return null;
  return { config };
}

/**
 * Calculate the transfer fee based on the package and transfer type.
 * BUG: For the "ultimate" package, feeSchedule is null because transfers
 * are free. Accessing .interacFee on null crashes with TypeError.
 */
function calculateFee(packageData, transferType) {
  const fee = transferType === 'interac'
    ? packageData.config.feeSchedule.interacFee
    : packageData.config.feeSchedule.sameInstitutionFee;
  return fee > 0 ? fee : 0;
}

/**
 * Build the transfer confirmation receipt.
 */
function buildReceipt(transferData, fee) {
  const totalDebit = transferData.amount + fee;
  return {
    receiptId: `SCO-${Date.now()}`,
    from: transferData.fromAccount,
    recipient: transferData.recipientName,
    bank: transferData.bank,
    amount: transferData.amount,
    fee: fee.toFixed(2),
    debitAmount: totalDebit.toFixed(2),
    transferType: transferData.transferType,
    memo: transferData.memo || '',
    timestamp: new Date().toISOString(),
    method: 'Transfer to Recipient',
  };
}

/**
 * Process a transfer to a recipient.
 */
async function processETransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Processing Scotiabank transfer', {
    transferId,
    fromAccount: data.fromAccount,
    recipient: data.recipientName,
    amount: data.amount,
    transferType: data.transferType,
    service: 'e433d32d-etransfer',
    route: '/api/e433d32d/etransfer',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const packageData = resolvePackage(data.package);
    const fee = calculateFee(packageData, data.transferType);
    const receipt = buildReceipt(data, fee);

    const duration = Date.now() - startTime;

    incrementMetric('etransfer.success', {
      route: '/api/e433d32d/etransfer',
      transferType: data.transferType,
    });
    recordTiming('etransfer.latency', duration, {
      route: '/api/e433d32d/etransfer',
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
      route: '/api/e433d32d/etransfer',
      errorClass: error.name,
      transferType: data.transferType,
    });
    recordTiming('etransfer.latency', duration, {
      route: '/api/e433d32d/etransfer',
      error: 'true',
    });

    logger.error('Scotiabank transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      recipient: data.recipientName,
      service: 'e433d32d-etransfer',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/e433d32d/etransfer',
        service: 'e433d32d-etransfer',
        transferType: data.transferType,
      },
      extra: {
        transferId,
        fromAccount: data.fromAccount,
        recipient: data.recipientName,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e433d32d.js \u2014 calculateFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'e433d32d-etransfer',
      verticalLabel: 'Scotiabank Transfers',
      customer: 'e433d32d',
      tags: [
        { key: 'route', value: '/api/e433d32d/etransfer' },
        { key: 'service', value: 'e433d32d-etransfer' },
        { key: 'transferType', value: data.transferType },
      ],
      extra: { transferId, fromAccount: data.fromAccount, recipient: data.recipientName, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'e433d32d-etransfer@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from transfer error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processETransfer, ACCOUNTS, RECIPIENTS, TRANSACTIONS };
