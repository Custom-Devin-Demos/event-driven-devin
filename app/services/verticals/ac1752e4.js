const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * KeyBank customer accounts for the demo
 */
const ACCOUNTS = [
  { id: 'KEY-CHK-7741', name: 'Key Smart Checking', type: 'premium', balance: 9215.40, currency: 'USD' },
  { id: 'KEY-SAV-2208', name: 'Key Active Saver', type: 'standard', balance: 27430.85, currency: 'USD' },
  { id: 'KEY-MM-5519', name: 'Key Money Market', type: 'basic', balance: 18650.00, currency: 'USD' },
];

/**
 * Saved Zelle recipients for the Send Money flow
 */
const PAYEES = [
  { id: 'PAYEE-2001', name: 'Morgan Avery', handle: 'morgan.avery@email.com', method: 'email', rail: 'zelle-instant' },
  { id: 'PAYEE-2002', name: 'Drew Bennett', handle: '+1 (216) 555-0173', method: 'mobile', rail: 'zelle-instant' },
  { id: 'PAYEE-2003', name: 'Lakeview Property Mgmt', handle: '****6042', method: 'account', rail: 'ach-standard' },
  { id: 'PAYEE-2004', name: 'Jamie Cortez', handle: 'jamie.cortez@email.com', method: 'email', rail: 'zelle-instant' },
];

/**
 * Recent payment activity for display
 */
const TRANSACTIONS = [
  { id: 'PMT-001', date: '2026-06-19', description: 'Zelle to Morgan Avery', amount: -95.00, type: 'debit', account: 'KEY-CHK-7741' },
  { id: 'PMT-002', date: '2026-06-17', description: 'Direct Deposit - Payroll', amount: 3120.00, type: 'credit', account: 'KEY-CHK-7741' },
  { id: 'PMT-003', date: '2026-06-16', description: 'Zelle to Lakeview Property Mgmt', amount: -1725.00, type: 'debit', account: 'KEY-CHK-7741' },
  { id: 'PMT-004', date: '2026-06-14', description: 'Received from Drew Bennett', amount: 80.00, type: 'credit', account: 'KEY-CHK-7741' },
  { id: 'PMT-005', date: '2026-06-11', description: 'Transfer to Key Active Saver', amount: -500.00, type: 'debit', account: 'KEY-CHK-7741' },
];

/**
 * Payment rails available for consumer money movement, keyed by rail id.
 * Each rail defines its settlement window and the fee schedule applied
 * to outbound transfers.
 */
const PAYMENT_RAILS = {
  'zelle-instant': { settlement: 'instant',   rate: 0.000, flat: 0.00 },
  'ach-standard':  { settlement: '1-3 days',  rate: 0.000, flat: 0.00 },
  'wire-domestic': { settlement: 'same day',  rate: 0.001, flat: 20.00 },
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
    confirmationId: `KEY-${Date.now()}`,
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
    service: 'key-consumer-payments-api',
    route: '/api/ac1752e4/payment',
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
      route: '/api/ac1752e4/payment',
      rail: data.rail,
    });
    recordTiming('payment.latency', duration, {
      route: '/api/ac1752e4/payment',
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
      route: '/api/ac1752e4/payment',
      errorClass: error.name,
      rail: data.rail,
    });
    recordTiming('payment.latency', duration, {
      route: '/api/ac1752e4/payment',
      error: 'true',
    });

    logger.error('Consumer payment failed', {
      paymentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      payeeId: data.payeeId,
      service: 'key-consumer-payments-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/ac1752e4/payment',
        service: 'key-consumer-payments-api',
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
      culprit: 'app/services/verticals/ac1752e4.js \u2014 calculateTransferFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'key-consumer-payments-api',
      verticalLabel: 'KeyBank Send Money with Zelle',
      customer: 'ac1752e4',
      tags: [
        { key: 'route', value: '/api/ac1752e4/payment' },
        { key: 'service', value: 'key-consumer-payments-api' },
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
      release: process.env.SENTRY_RELEASE || 'key-consumer-payments@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from payment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processPayment, ACCOUNTS, PAYEES, TRANSACTIONS, PAYMENT_RAILS };
