const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/cardpayment/payment';
const SERVICE = 'card-payments-api';

/**
 * Deposit accounts that can fund a card payment, keyed by the account
 * reference the dashboard sends.
 */
const FUNDING_ACCOUNTS = {
  'CHK-1634': { id: 'CHK-1634', label: 'My Checking', product: 'checking', balance: 4000.00 },
  'SAV-8820': { id: 'SAV-8820', label: 'My Savings', product: 'savings', balance: 7680.90 },
};

const CARD_ACCOUNTS = {
  'CARD-4417': { id: 'CARD-4417', label: 'BankAmericard Credit Card', minimumDue: 25.00, statementBalance: 412.37 },
};

/**
 * How a payment from each deposit product posts to the card ledger: the
 * internal rail and its same-day cutoff (hour, Eastern).
 */
const POSTING_RULES = {
  dda: { rail: 'book-transfer', cutoffHourEt: 20 },
  savings: { rail: 'book-transfer', cutoffHourEt: 20 },
};

function invalidPayment(message, code = 'INVALID_PAYMENT') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function postsSameDay(date, cutoffHourEt) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    weekday: 'short', hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return !['Sat', 'Sun'].includes(parts.weekday) && Number(parts.hour) < cutoffHourEt;
}

/** Validates the request and returns the payment amount in whole cents. */
function validatePayment(data) {
  const funding = Object.hasOwn(FUNDING_ACCOUNTS, data.fromAccount) ? FUNDING_ACCOUNTS[data.fromAccount] : null;
  if (!funding) throw invalidPayment(`Unknown funding account: ${data.fromAccount}`);
  const card = Object.hasOwn(CARD_ACCOUNTS, data.toAccount) ? CARD_ACCOUNTS[data.toAccount] : null;
  if (!card) throw invalidPayment(`Unknown card account: ${data.toAccount}`);
  const amount = Number(data.amount);
  const cents = Math.round(amount * 100);
  if (!Number.isFinite(amount) || amount < 1 || Math.abs(amount * 100 - cents) > 1e-6) {
    throw invalidPayment('Payment amount must be at least $1.00 and in whole cents');
  }
  if (cents > Math.round(funding.balance * 100)) {
    throw invalidPayment('Payment amount exceeds the available balance', 'INSUFFICIENT_FUNDS');
  }
  return { funding, card, cents };
}

/**
 * Schedule a credit card payment from a deposit account. Card payments are
 * fee-free; the receipt reflects exactly the amount debited.
 */
async function submitCardPayment(data, now = new Date()) {
  const startTime = Date.now();
  const paymentId = `PMT${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

  logger.info('Card payment started', {
    paymentId, fromAccount: data.fromAccount, toAccount: data.toAccount, service: SERVICE, route: ROUTE,
  });

  try {
    const { funding, card, cents } = validatePayment(data);
    const rule = POSTING_RULES[funding.product];
    const sameDay = postsSameDay(now, rule.cutoffHourEt);
    const amount = cents / 100;

    incrementMetric('card.payment.success', { route: ROUTE, product: funding.product });
    recordTiming('card.payment.latency', Date.now() - startTime, { route: ROUTE });

    logger.info('Card payment scheduled', { paymentId, product: funding.product, rail: rule.rail, service: SERVICE });

    return {
      success: true,
      paymentId,
      confirmationNumber: `BA${paymentId.slice(-8)}`,
      fromAccount: { id: funding.id, label: funding.label },
      toAccount: { id: card.id, label: card.label },
      amount: amount.toFixed(2),
      fee: '0.00',
      totalDebit: amount.toFixed(2),
      rail: rule.rail,
      postsOn: sameDay ? 'today' : 'next_business_day',
      scheduledAt: now.toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('card.payment.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('card.payment.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Card payment failed', {
      paymentId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration,
      fromAccount: data.fromAccount, service: SERVICE,
    });
    if (!error.code) {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE },
        extra: { paymentId, fromAccount: data.fromAccount },
      });
    }
    throw error;
  }
}

module.exports = { submitCardPayment, FUNDING_ACCOUNTS, CARD_ACCOUNTS, POSTING_RULES };
