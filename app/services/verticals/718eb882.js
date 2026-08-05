const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Checking products. Each product sets the daily transfer ceiling and the
 * number of free same-day transfers included before the per-item fee applies.
 */
const CHECKING_PRODUCTS = {
  'asterisk-free': { label: 'Asterisk-Free Checking', dailyTransferLimit: 2500, freeTransfers: 6, perItemFee: 1.5 },
  perks: { label: 'Perks Checking', dailyTransferLimit: 10000, freeTransfers: 25, perItemFee: 0 },
  'platinum-perks': { label: 'Platinum Perks Checking', dailyTransferLimit: 25000, freeTransfers: 999, perItemFee: 0 },
};

/**
 * Customer accounts as returned by the deposit system of record. The ledger
 * exposes the customer's checking product on `productId`.
 */
const ACCOUNTS = [
  {
    id: 'CHK-4417',
    name: 'Asterisk-Free Checking',
    type: 'checking',
    routing: '044000024',
    balance: 5312.87,
    productId: 'platinum-perks',
    transfersThisCycle: 3,
  },
  {
    id: 'SAV-8820',
    name: 'Huntington Relationship Savings',
    type: 'savings',
    routing: '044000024',
    balance: 21475.4,
    productId: 'platinum-perks',
    transfersThisCycle: 1,
  },
  {
    id: 'CC-6031',
    name: 'Huntington Voice Rewards Credit Card',
    type: 'credit-card',
    balance: -1284.63,
    productId: 'platinum-perks',
    transfersThisCycle: 0,
  },
  {
    id: 'HEL-2209',
    name: 'Huntington Home Equity Line',
    type: 'line-of-credit',
    balance: -48210.05,
    productId: 'platinum-perks',
    transfersThisCycle: 0,
  },
];

/**
 * Resolve the checking product that governs a customer's transfer entitlements.
 */
function resolveProduct(account) {
  return CHECKING_PRODUCTS[account.productCode];
}

/**
 * Apply product entitlement rules to a requested transfer: the daily ceiling
 * first, then the per-item fee once the included transfers are used up.
 */
function assessEntitlements(account, amount) {
  const product = resolveProduct(account);

  if (amount > product.dailyTransferLimit) {
    const err = new Error(`Transfer of $${amount.toFixed(2)} exceeds your daily transfer limit of $${product.dailyTransferLimit.toFixed(2)}.`);
    err.name = 'TransferLimitExceededError';
    err.code = 'LIMIT_EXCEEDED';
    throw err;
  }

  const fee = account.transfersThisCycle >= product.freeTransfers ? product.perItemFee : 0;

  return { productLabel: product.label, dailyTransferLimit: product.dailyTransferLimit, fee };
}

/**
 * Build the confirmation number shown on the transfer receipt.
 */
function buildConfirmationNumber(transferId) {
  return `HB${transferId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

/**
 * Process an account-to-account transfer initiated from The Hub.
 */
async function processTransfer(data) {
  const startTime = Date.now();
  const transferId = uuidv4();

  logger.info('Processing Huntington account transfer', {
    transferId,
    fromAccount: data.fromAccount,
    toAccount: data.toAccount,
    amount: data.amount,
    service: 'huntington-online-banking',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const from = ACCOUNTS.find((a) => a.id === data.fromAccount);
    const to = ACCOUNTS.find((a) => a.id === data.toAccount);
    const amount = Number(data.amount);

    if (!from || !to) {
      const err = new Error('Choose a valid account to transfer from and to.');
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
      const err = new Error('There is not enough available money in the account you selected.');
      err.name = 'InsufficientFundsError';
      err.code = 'INSUFFICIENT_FUNDS';
      throw err;
    }

    const duration = Date.now() - startTime;
    incrementMetric('huntington_transfer.success', { route: '/api/718eb882/transfer' });
    recordTiming('huntington_transfer.latency', duration, { route: '/api/718eb882/transfer' });

    return {
      success: true,
      transferId,
      confirmationNumber: buildConfirmationNumber(transferId),
      fromAccount: { id: from.id, name: from.name, balance: Math.round((from.balance - amount - entitlements.fee) * 100) / 100 },
      toAccount: { id: to.id, name: to.name },
      amount: Math.round(amount * 100) / 100,
      fee: entitlements.fee,
      productLabel: entitlements.productLabel,
      currency: 'USD',
      postedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('huntington_transfer.failure', { route: '/api/718eb882/transfer', errorClass: error.name });
    recordTiming('huntington_transfer.latency', duration, { route: '/api/718eb882/transfer', error: 'true' });
    logger.error('Huntington account transfer failed', {
      transferId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/718eb882/transfer',
        service: 'huntington-online-banking',
      },
      extra: { transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/718eb882.js \u2014 assessEntitlements',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'huntington-online-banking',
      verticalLabel: 'Huntington Bank \u2014 Online Banking',
      customer: '718eb882',
      tags: [
        { key: 'route', value: '/api/718eb882/transfer' },
        { key: 'service', value: 'huntington-online-banking' },
      ],
      extra: { transferId, fromAccount: data.fromAccount, toAccount: data.toAccount, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'huntington-online-banking@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from Huntington transfer error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = { processTransfer, ACCOUNTS, CHECKING_PRODUCTS };
