const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Fifth Third Bank customer accounts for the demo
 */
const ACCOUNTS = [
  { id: '53-CHK-2208', name: 'Fifth Third Momentum Checking', type: 'premium', balance: 6295.40, currency: 'USD' },
  { id: '53-SAV-7714', name: 'Fifth Third Momentum Savings', type: 'standard', balance: 24310.85, currency: 'USD' },
  { id: '53-MM-5061', name: 'Fifth Third Relationship Money Market', type: 'basic', balance: 18750.00, currency: 'USD' },
];

/**
 * Saved recipients for the Send Money with Zelle flow
 */
const RECIPIENTS = [
  { id: 'RCPT-2001', name: 'Alex Whitfield', handle: 'alex.whitfield@email.com', method: 'email', deliveryOption: 'zelle-instant' },
  { id: 'RCPT-2002', name: 'Priya Nandakumar', handle: '+1 (513) 555-0178', method: 'mobile', deliveryOption: 'zelle-instant' },
  { id: 'RCPT-2003', name: 'Riverbend Property Group', handle: '****3390', method: 'account', deliveryOption: 'ach-standard' },
  { id: 'RCPT-2004', name: 'Devon Ellis', handle: 'devon.ellis@email.com', method: 'email', deliveryOption: 'zelle-instant' },
];

/**
 * Recent payment activity for display
 */
const TRANSACTIONS = [
  { id: 'PMT-101', date: '2026-08-14', description: 'Sent to Alex Whitfield', amount: -85.00, type: 'debit', account: '53-CHK-2208' },
  { id: 'PMT-102', date: '2026-08-13', description: 'Direct Deposit - Payroll', amount: 3120.00, type: 'credit', account: '53-CHK-2208' },
  { id: 'PMT-103', date: '2026-08-11', description: 'Sent to Riverbend Property Group', amount: -1625.00, type: 'debit', account: '53-CHK-2208' },
  { id: 'PMT-104', date: '2026-08-09', description: 'Received from Priya Nandakumar', amount: 140.00, type: 'credit', account: '53-CHK-2208' },
  { id: 'PMT-105', date: '2026-08-07', description: 'Transfer to Momentum Savings', amount: -350.00, type: 'debit', account: '53-CHK-2208' },
];

/**
 * Delivery options available for consumer money movement, keyed by option id.
 * Each option defines its settlement window and the fee schedule applied to
 * outbound payments.
 */
const DELIVERY_OPTIONS = {
  'zelle-instant': { settlement: 'minutes',    rate: 0.000, flat: 0.00 },
  'ach-standard':  { settlement: '1-3 days',   rate: 0.000, flat: 0.00 },
  'wire-domestic': { settlement: 'same day',   rate: 0.001, flat: 25.00 },
};

/**
 * Resolve the fee schedule for a given delivery option.
 */
function resolveDeliveryOption(optionId) {
  const option = DELIVERY_OPTIONS[optionId];
  if (!option) return null;
  return { params: [option.rate, option.flat], settlement: option.settlement };
}

/**
 * Calculate the outbound send fee from the resolved delivery option data.
 */
function calculateSendFee(optionData, amount) {
  const variableFee = optionData.schedule.rate * amount;
  const minimumFee = optionData.schedule.flat;
  return Math.max(variableFee, minimumFee);
}

/**
 * Build the payment confirmation for the response.
 */
function formatConfirmation(payment, feeBreakdown) {
  return {
    confirmationId: `FTB-${Date.now()}`,
    fromAccount: payment.fromAccount,
    recipientId: payment.recipientId,
    recipientName: payment.recipientName,
    amount: payment.amount.toFixed(2),
    fee: feeBreakdown.fee.toFixed(2),
    totalDebit: feeBreakdown.totalDebit.toFixed(2),
    settlement: feeBreakdown.settlement,
    memo: payment.memo || '',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a consumer payment / money transfer to a saved recipient.
 */
async function processPayment(data) {
  const startTime = Date.now();
  const paymentId = uuidv4();

  logger.info('Processing consumer payment', {
    paymentId,
    fromAccount: data.fromAccount,
    recipientId: data.recipientId,
    amount: data.amount,
    deliveryOption: data.deliveryOption,
    service: 'ftb-consumer-payments-api',
    route: '/api/6820f69a/payment',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const optionData = resolveDeliveryOption(data.deliveryOption);
    const fee = calculateSendFee(optionData, data.amount);
    const totalDebit = data.amount + fee;
    const confirmation = formatConfirmation(data, {
      fee,
      totalDebit,
      settlement: optionData.settlement,
    });

    const duration = Date.now() - startTime;

    incrementMetric('payment.success', {
      route: '/api/6820f69a/payment',
      deliveryOption: data.deliveryOption,
    });
    recordTiming('payment.latency', duration, {
      route: '/api/6820f69a/payment',
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
      route: '/api/6820f69a/payment',
      errorClass: error.name,
      deliveryOption: data.deliveryOption,
    });
    recordTiming('payment.latency', duration, {
      route: '/api/6820f69a/payment',
      error: 'true',
    });

    logger.error('Consumer payment failed', {
      paymentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fromAccount: data.fromAccount,
      recipientId: data.recipientId,
      service: 'ftb-consumer-payments-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/6820f69a/payment',
        service: 'ftb-consumer-payments-api',
        deliveryOption: data.deliveryOption,
      },
      extra: {
        paymentId,
        fromAccount: data.fromAccount,
        recipientId: data.recipientId,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6820f69a.js \u2014 calculateSendFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'ftb-consumer-payments-api',
      verticalLabel: 'Fifth Third Bank Send Money',
      customer: '6820f69a',
      tags: [
        { key: 'route', value: '/api/6820f69a/payment' },
        { key: 'service', value: 'ftb-consumer-payments-api' },
        { key: 'deliveryOption', value: data.deliveryOption },
      ],
      extra: { paymentId, fromAccount: data.fromAccount, recipientId: data.recipientId, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'ftb-consumer-payments@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from payment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processPayment, ACCOUNTS, RECIPIENTS, TRANSACTIONS, DELIVERY_OPTIONS };
