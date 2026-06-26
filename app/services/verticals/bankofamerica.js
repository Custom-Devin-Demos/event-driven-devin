const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Bank of America customer accounts for the demo
 */
const ACCOUNTS = [
  { id: 'BOA-ADV-7741', name: 'Advantage Plus Banking', type: 'checking', balance: 12480.66, currency: 'USD' },
  { id: 'BOA-SAV-3309', name: 'Advantage Savings', type: 'savings', balance: 48210.40, currency: 'USD' },
  { id: 'BOA-CCR-9920', name: 'Customized Cash Rewards', type: 'credit', balance: -842.17, currency: 'USD' },
];

/**
 * Saved recipients for the Transfer | Zelle flow
 */
const RECIPIENTS = [
  { id: 'RCP-2001', name: 'Maria Gonzalez', handle: 'maria.gonzalez@email.com', method: 'email', network: 'zelle' },
  { id: 'RCP-2002', name: 'David Chen', handle: '+1 (415) 555-0173', method: 'mobile', network: 'zelle' },
  { id: 'RCP-2003', name: 'Oak Street Realty', handle: '****4471', method: 'account', network: 'wire' },
  { id: 'RCP-2004', name: 'Ashley Brooks', handle: 'ashley.brooks@email.com', method: 'email', network: 'zelle' },
];

/**
 * Recent activity for display
 */
const TRANSACTIONS = [
  { id: 'ACT-001', date: '2026-06-22', description: 'Direct Deposit - Payroll', amount: 3120.00, type: 'credit', account: 'BOA-ADV-7741' },
  { id: 'ACT-002', date: '2026-06-21', description: 'Zelle to Maria Gonzalez', amount: -200.00, type: 'debit', account: 'BOA-ADV-7741' },
  { id: 'ACT-003', date: '2026-06-20', description: 'Whole Foods Market', amount: -134.88, type: 'debit', account: 'BOA-ADV-7741' },
  { id: 'ACT-004', date: '2026-06-19', description: 'Preferred Rewards Bonus', amount: 18.75, type: 'credit', account: 'BOA-ADV-7741' },
  { id: 'ACT-005', date: '2026-06-17', description: 'Domestic Wire - Oak Street Realty', amount: -2500.00, type: 'debit', account: 'BOA-ADV-7741' },
];

/**
 * Preferred Rewards tiers and their transfer fee schedule.
 *
 * NOTE: The "platinum-honors" tier has feeSchedule explicitly set to null
 * because the program waives all outbound transfer and domestic wire fees.
 * The fee calculation is expected to short-circuit for this tier before it
 * reads any schedule properties. However, calculateTransferFee reads the
 * schedule unconditionally.
 */
const REWARDS_TIERS = {
  'platinum-honors': { name: 'Platinum Honors', feeSchedule: null },
  platinum:          { name: 'Platinum',        feeSchedule: { domesticWire: 30.00, externalTransfer: 3.00 } },
  gold:              { name: 'Gold',            feeSchedule: { domesticWire: 30.00, externalTransfer: 3.00 } },
  standard:          { name: 'Standard',        feeSchedule: { domesticWire: 30.00, externalTransfer: 3.00 } },
};

/**
 * Resolve the Preferred Rewards tier configuration.
 */
function resolveRewardsTier(tier) {
  const config = REWARDS_TIERS[tier];
  if (!config) return null;
  return { config };
}

/**
 * Calculate the outbound transfer fee for the resolved tier.
 * BUG: For "platinum-honors", feeSchedule is null because transfers are
 * fee-free. Reading .domesticWire / .externalTransfer on null crashes
 * with a TypeError.
 */
function calculateTransferFee(tierData, transferType) {
  const schedule = tierData.config.feeSchedule;
  const fee = transferType === 'wire' ? schedule.domesticWire : schedule.externalTransfer;
  return fee > 0 ? fee : 0;
}

/**
 * Build the transfer confirmation receipt.
 */
function buildReceipt(transferData, fee) {
  const totalDebit = transferData.amount + fee;
  return {
    confirmationId: `BOA-${Date.now()}`,
    fromAccount: transferData.fromAccount,
    recipient: transferData.recipient,
    amount: transferData.amount.toFixed(2),
    fee: fee.toFixed(2),
    totalDebit: totalDebit.toFixed(2),
    memo: transferData.memo || '',
    network: transferData.transferType === 'wire' ? 'Domestic Wire' : 'Zelle',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a consumer money transfer (Zelle or domestic wire).
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Processing consumer transfer', {
    transferId,
    fromAccount: data.fromAccount,
    recipient: data.recipient,
    amount: data.amount,
    transferType: data.transferType,
    rewardsTier: data.rewardsTier,
    service: 'boa-consumer-transfers',
    route: '/api/bankofamerica/transfer',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const tierData = resolveRewardsTier(data.rewardsTier);
    const fee = calculateTransferFee(tierData, data.transferType);
    const receipt = buildReceipt(data, fee);

    const duration = Date.now() - startTime;

    incrementMetric('transfer.success', {
      route: '/api/bankofamerica/transfer',
      rewardsTier: data.rewardsTier,
    });
    recordTiming('transfer.latency', duration, {
      route: '/api/bankofamerica/transfer',
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
      route: '/api/bankofamerica/transfer',
      errorClass: error.name,
      rewardsTier: data.rewardsTier,
    });
    recordTiming('transfer.latency', duration, {
      route: '/api/bankofamerica/transfer',
      error: 'true',
    });

    logger.error('Consumer transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      recipient: data.recipient,
      service: 'boa-consumer-transfers',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/bankofamerica/transfer',
        service: 'boa-consumer-transfers',
        rewardsTier: data.rewardsTier,
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
      culprit: 'app/services/verticals/bankofamerica.js \u2014 calculateTransferFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'boa-consumer-transfers',
      verticalLabel: 'Bank of America Transfer | Zelle',
      customer: 'bankofamerica',
      tags: [
        { key: 'route', value: '/api/bankofamerica/transfer' },
        { key: 'service', value: 'boa-consumer-transfers' },
        { key: 'rewardsTier', value: data.rewardsTier },
      ],
      extra: { transferId, fromAccount: data.fromAccount, recipient: data.recipient, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'boa-consumer-transfers@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from transfer error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processTransfer, ACCOUNTS, RECIPIENTS, TRANSACTIONS, REWARDS_TIERS };
