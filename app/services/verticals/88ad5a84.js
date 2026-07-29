const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Client banking packages. Each package sets the per-day transfer ceiling and
 * the number of free transfers included before per-item fees apply.
 */
const CLIENT_PACKAGES = {
  'day-to-day': { label: 'RBC Day to Day Banking', dailyTransferLimit: 3000, freeTransfers: 12, perItemFee: 1.25 },
  'signature-no-limit': { label: 'RBC Signature No Limit Banking', dailyTransferLimit: 10000, freeTransfers: 999, perItemFee: 0 },
  'vip-banking': { label: 'RBC VIP Banking', dailyTransferLimit: 25000, freeTransfers: 999, perItemFee: 0 },
};

/**
 * Client accounts as returned by the core banking ledger. The ledger exposes the
 * client's banking package on `packageId`.
 */
const ACCOUNTS = [
  {
    id: 'CHQ-1004729',
    name: 'RBC Day to Day Banking',
    type: 'chequing',
    transit: '05812',
    balance: 4286.51,
    packageId: 'vip-banking',
    transfersThisCycle: 4,
  },
  {
    id: 'SAV-4471118',
    name: 'RBC High Interest eSavings',
    type: 'savings',
    transit: '05812',
    balance: 18940.22,
    packageId: 'vip-banking',
    transfersThisCycle: 1,
  },
  {
    id: 'CC-8802',
    name: 'RBC Avion Visa Infinite',
    type: 'credit-card',
    balance: -1742.09,
    packageId: 'vip-banking',
    transfersThisCycle: 0,
  },
  {
    id: 'MTG-90114',
    name: 'RBC Homeline Plan Mortgage',
    type: 'mortgage',
    balance: -312884.1,
    packageId: 'vip-banking',
    transfersThisCycle: 0,
  },
];

/**
 * Resolve the banking package that governs a client's transfer entitlements.
 */
function resolvePackage(account) {
  return CLIENT_PACKAGES[account.packageCode];
}

/**
 * Apply the package entitlement rules to a requested transfer: daily ceiling
 * first, then the per-item fee once the included transfers are used up.
 */
function assessEntitlements(account, amount) {
  const clientPackage = resolvePackage(account);

  if (amount > clientPackage.dailyTransferLimit) {
    const err = new Error(`Transfer of $${amount.toFixed(2)} exceeds your daily limit of $${clientPackage.dailyTransferLimit.toFixed(2)}.`);
    err.name = 'TransferLimitExceededError';
    err.code = 'LIMIT_EXCEEDED';
    throw err;
  }

  const fee = account.transfersThisCycle >= clientPackage.freeTransfers ? clientPackage.perItemFee : 0;

  return { packageLabel: clientPackage.label, dailyTransferLimit: clientPackage.dailyTransferLimit, fee };
}

/**
 * Build a 9-character confirmation number in the format shown on the receipt.
 */
function buildConfirmationNumber(transferId) {
  return `RB${transferId.replace(/-/g, '').slice(0, 7).toUpperCase()}`;
}

/**
 * Process an account-to-account transfer initiated from Accounts Summary.
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Processing RBC account transfer', {
    transferId,
    fromAccount: data.fromAccount,
    toAccount: data.toAccount,
    amount: data.amount,
    service: 'rbc-online-banking',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const from = ACCOUNTS.find((a) => a.id === data.fromAccount);
    const to = ACCOUNTS.find((a) => a.id === data.toAccount);
    const amount = Number(data.amount);

    if (!from || !to) {
      const err = new Error('Select a valid account to transfer from and to.');
      err.name = 'UnknownAccountError';
      err.code = 'UNKNOWN_ACCOUNT';
      throw err;
    }

    if (!amount || amount <= 0) {
      const err = new Error('Enter a transfer amount greater than $0.00.');
      err.name = 'InvalidAmountError';
      err.code = 'INVALID_AMOUNT';
      throw err;
    }

    const entitlements = assessEntitlements(from, amount);

    if (amount + entitlements.fee > from.balance) {
      const err = new Error('There are not enough available funds in the account you selected.');
      err.name = 'InsufficientFundsError';
      err.code = 'INSUFFICIENT_FUNDS';
      throw err;
    }

    const duration = Date.now() - startTime;
    incrementMetric('rbc_transfer.success', { route: '/api/88ad5a84/transfer' });
    recordTiming('rbc_transfer.latency', duration, { route: '/api/88ad5a84/transfer' });

    return {
      success: true,
      transferId,
      confirmationNumber: buildConfirmationNumber(transferId),
      fromAccount: { id: from.id, name: from.name, balance: Math.round((from.balance - amount - entitlements.fee) * 100) / 100 },
      toAccount: { id: to.id, name: to.name },
      amount: Math.round(amount * 100) / 100,
      fee: entitlements.fee,
      packageLabel: entitlements.packageLabel,
      currency: 'CAD',
      postedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('rbc_transfer.failure', { route: '/api/88ad5a84/transfer', errorClass: error.name });
    recordTiming('rbc_transfer.latency', duration, { route: '/api/88ad5a84/transfer', error: 'true' });
    logger.error('RBC account transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/88ad5a84/transfer',
        service: 'rbc-online-banking',
      },
      extra: { transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/88ad5a84.js \u2014 assessEntitlements',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'rbc-online-banking',
      verticalLabel: 'RBC Royal Bank \u2014 Online Banking',
      customer: '88ad5a84',
      tags: [
        { key: 'route', value: '/api/88ad5a84/transfer' },
        { key: 'service', value: 'rbc-online-banking' },
      ],
      extra: { transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'rbc-online-banking@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from RBC transfer error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = { processTransfer, ACCOUNTS, CLIENT_PACKAGES };
