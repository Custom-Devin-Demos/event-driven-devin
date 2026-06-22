const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * TD Bank customer accounts for the demo
 */
const ACCOUNTS = [
  { id: 'TD-CHK-4417', name: 'TD Convenience Checking', type: 'premium', balance: 8420.55, currency: 'USD' },
  { id: 'TD-SAV-9023', name: 'TD Simple Savings', type: 'standard', balance: 31875.10, currency: 'USD' },
  { id: 'TD-MM-3360', name: 'TD Growth Money Market', type: 'basic', balance: 15240.00, currency: 'USD' },
];

/**
 * Saved payees (person-to-person recipients) for the Send Money flow
 */
const PAYEES = [
  { id: 'PAYEE-1001', name: 'Jordan Rivera', handle: 'jordan.rivera@email.com', method: 'email', rail: 'p2p-instant' },
  { id: 'PAYEE-1002', name: 'Sam Patel', handle: '+1 (617) 555-0142', method: 'mobile', rail: 'p2p-instant' },
  { id: 'PAYEE-1003', name: 'Greenline Property Mgmt', handle: '****8821', method: 'account', rail: 'ach-standard' },
  { id: 'PAYEE-1004', name: 'Casey Morgan', handle: 'casey.morgan@email.com', method: 'email', rail: 'p2p-instant' },
];

/**
 * Recent payment activity for display
 */
const TRANSACTIONS = [
  { id: 'PMT-001', date: '2026-06-18', description: 'Sent to Jordan Rivera', amount: -120.00, type: 'debit', account: 'TD-CHK-4417' },
  { id: 'PMT-002', date: '2026-06-16', description: 'Direct Deposit - Payroll', amount: 2840.00, type: 'credit', account: 'TD-CHK-4417' },
  { id: 'PMT-003', date: '2026-06-15', description: 'Sent to Greenline Property Mgmt', amount: -1850.00, type: 'debit', account: 'TD-CHK-4417' },
  { id: 'PMT-004', date: '2026-06-14', description: 'Received from Sam Patel', amount: 65.00, type: 'credit', account: 'TD-CHK-4417' },
  { id: 'PMT-005', date: '2026-06-12', description: 'Transfer to TD Simple Savings', amount: -400.00, type: 'debit', account: 'TD-CHK-4417' },
];

/**
 * Payment rails available for consumer money movement, keyed by rail id.
 * Each rail defines its settlement window and the fee schedule applied
 * to outbound transfers.
 */
const PAYMENT_RAILS = {
  'p2p-instant':  { settlement: 'instant',   rate: 0.000, flat: 0.00 },
  'ach-standard': { settlement: '1-3 days',  rate: 0.000, flat: 0.00 },
  'wire-domestic':{ settlement: 'same day',  rate: 0.001, flat: 15.00 },
};

/**
 * Resolve the fee schedule for a given payment rail.
 */
async function resolvePaymentRail(railId) {
  const rail = PAYMENT_RAILS[railId];
  if (!rail) return null;
  return { params: [rail.rate, rail.flat], settlement: rail.settlement };
}

/**
 * Calculate the outbound transfer fee from the resolved rail data.
 */
function calculateTransferFee(railData, amount) {
  const variableFee = railData.schedule.rate * amount;
  const minimumFee = railData.schedule.flat;
  return Math.max(variableFee, minimumFee);
}

/**
 * Build the payment confirmation for the response.
 */
function formatConfirmation(payment, feeBreakdown) {
  return {
    confirmationId: `TDC-${Date.now()}`,
    fromAccount: payment.fromAccount,
    payeeId: payment.payeeId,
    payeeName: payment.payeeName,
    amount: payment.amount.toFixed(2),
    fee: feeBreakdown.fee.toFixed(2),
    totalDebit: feeBreakdown.totalDebit.toFixed(2),
    settlement: feeBreakdown.settlement,
    memo: payment.memo || '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a consumer payment / money transfer to a payee.
 */
async function processPayment(data) {
  const startTime = Date.now();
  const paymentId = uuidv4();

  logger.info('Processing consumer payment', {
    paymentId,
    fromAccount: data.fromAccount,
    payeeId: data.payeeId,
    amount: data.amount,
    rail: data.rail,
    service: 'td-consumer-payments-api',
    route: '/api/tdbank/payment',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const railData = resolvePaymentRail(data.rail);
    const fee = calculateTransferFee(railData, data.amount);
    const totalDebit = data.amount + fee;
    const confirmation = formatConfirmation(data, {
      fee,
      totalDebit,
      settlement: railData.settlement,
    });

    const duration = Date.now() - startTime;

    incrementMetric('payment.success', {
      route: '/api/tdbank/payment',
      rail: data.rail,
    });
    recordTiming('payment.latency', duration, {
      route: '/api/tdbank/payment',
    });

    return {
      success: true,
      paymentId,
      confirmation,
      status: 'completed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('payment.failure', {
      route: '/api/tdbank/payment',
      errorClass: error.name,
      rail: data.rail,
    });
    recordTiming('payment.latency', duration, {
      route: '/api/tdbank/payment',
      error: 'true',
    });

    logger.error('Consumer payment failed', {
      paymentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      payeeId: data.payeeId,
      service: 'td-consumer-payments-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/tdbank/payment',
        service: 'td-consumer-payments-api',
        rail: data.rail,
      },
      extra: {
        paymentId,
        fromAccount: data.fromAccount,
        payeeId: data.payeeId,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/tdbank.js \u2014 calculateTransferFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'td-consumer-payments-api',
      verticalLabel: 'TD Bank Send Money',
      customer: 'tdbank',
      tags: [
        { key: 'route', value: '/api/tdbank/payment' },
        { key: 'service', value: 'td-consumer-payments-api' },
        { key: 'rail', value: data.rail },
      ],
      extra: { paymentId, fromAccount: data.fromAccount, payeeId: data.payeeId, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'td-consumer-payments@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from payment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processPayment, ACCOUNTS, PAYEES, TRANSACTIONS, PAYMENT_RAILS };
