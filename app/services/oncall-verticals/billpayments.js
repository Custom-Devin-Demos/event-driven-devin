const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { queueIncidentChannelInvites } = require('../datadog-incident-slack');
const { getOncallSkin } = require('../../../config/oncall-skins');

const SKIN = 'cf420e9d';
const SERVICE = 'billpay-payments-gateway';
const ROUTE = '/api/oncall/billpayments/submit';
const RELEASE = 'billpay-gateway@2026.11.4';
const REPO_URL = 'https://github.com/COG-GTM/xfinity-sev-1';
const INCIDENT_WINDOW_MS = 5 * 60 * 1000;
const INCIDENT_SEVERITY = 'SEV-1';
const INCIDENT_CHANNEL_PREFIX = 'sev-1-incident';
const BILL = Object.freeze({
  id: 'XF-BILL-1202',
  accountNumber: '8495-1120-0418',
  balance: 184.97,
  dueDate: 'Dec 2, 2026',
  billingProfile: 'res-card@v7',
});

/**
 * Wallet the account holder can pay from, keyed by method id.
 */
const PAYMENT_METHODS = {
  'pm-visa-4421': { label: 'Visa \u2022\u2022\u2022\u2022 4421', rail: 'card' },
  'pm-chk-0917': { label: 'PNC Checking \u2022\u2022\u2022\u2022 0917', rail: 'ach' },
};

/**
 * Payment processors that authorize one-time bill payments. The gateway
 * selects one from the account's billing profile.
 */
const PAYMENT_PROCESSORS = {
  paymentech_v1: {
    authorize: async (payment) => ({ success: true, paymentId: payment.id, status: 'POSTED', amount: payment.amount }),
  },
};

// Residential billing profiles moved to processor routing v2 in the 2026.11 gateway release.
const BILLING_PROFILES = {
  'res-card@v7': { processor: 'paymentech_v2', settlement: 'same_day' },
};

let openIncident = null;
let declaringIncident = null;

function processorFor(payment) {
  return BILLING_PROFILES[payment.billingProfile].processor;
}

async function authorizePayment(payment) {
  const processor = PAYMENT_PROCESSORS[processorFor(payment)];
  return processor.authorize(payment);
}

async function paymentsIncident(triggeredBy) {
  if (openIncident && Date.now() - openIncident.declaredAt < INCIDENT_WINDOW_MS) {
    return { ...openIncident, reused: true };
  }
  if (declaringIncident) return declaringIncident;
  const runRef = `xf-billpay-${uuidv4().slice(0, 8)}`;
  declaringIncident = (async () => {
    try {
      const incident = await declareDatadogIncident({
        title: 'Xfinity: My Account bill payment outage',
        summary: `One-time bill payments in Xfinity My Account return HTTP 503 following ${RELEASE}. Payment for bill ${BILL.id} ($${BILL.balance}) was not authorized and no funds were taken; scheduled AutoPay runs for the same billing profile are blocked. Every residential card and bank payment is affected. Internet plan changes are a separate alert. Investigate only the bill payment gateway's processor resolution in billpay-payments-gateway (src/billpayments.js in ${REPO_URL}).`,
        runRef,
        service: SERVICE,
        triggeredBy,
        repoUrl: REPO_URL,
        severity: INCIDENT_SEVERITY,
      });
      if (!incident) return { status: 'unavailable', runRef };
      openIncident = { status: 'declared', ...incident, runRef, channelPrefix: INCIDENT_CHANNEL_PREFIX, declaredAt: Date.now() };
      queueIncidentChannelInvites({ publicId: incident.publicId, userIds: getOncallSkin(SKIN).incidentInviteUserIds });
      logger.info('Xfinity bill payment incident declared', { service: SERVICE, ...openIncident });
      return openIncident;
    } catch (error) {
      logger.warn('Xfinity bill payment incident declaration failed', { service: SERVICE, runRef, error: error.message });
      return { status: 'failed', runRef };
    }
  })();
  try {
    return await declaringIncident;
  } finally {
    declaringIncident = null;
  }
}

function invalid(error) {
  return { statusCode: 400, body: { success: false, code: 'INVALID_PAYMENT', error } };
}

async function submitPayment({ billId, methodId, amount, devinEmail } = {}) {
  if (billId !== BILL.id) return invalid('Choose the bill you want to pay.');
  const method = typeof methodId === 'string' && Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, methodId) ? PAYMENT_METHODS[methodId] : null;
  if (!method) return invalid('Choose a payment method.');
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents < 100 || cents > Math.round(BILL.balance * 100)) {
    return invalid(`Enter an amount between $1.00 and $${BILL.balance.toFixed(2)}.`);
  }
  const started = Date.now();
  const requestId = uuidv4();
  const payment = { id: requestId, billId, accountNumber: BILL.accountNumber, billingProfile: BILL.billingProfile, rail: method.rail, amount: cents / 100 };
  try {
    const result = await authorizePayment(payment);
    return { statusCode: 200, body: { ...result, method: method.label, confirmation: `XFP-${requestId.slice(0, 8).toUpperCase()}` } };
  } catch (error) {
    const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
    incrementMetric('billpay.payment.failure', tags);
    recordTiming('billpay.payment.latency', Date.now() - started, tags);
    logger.error('Xfinity bill payment gateway unavailable', {
      ...tags, requestId, billId, billingProfile: BILL.billingProfile, rail: method.rail, amount: payment.amount,
      statusCode: 503, error: error.message, errorClass: error.name, stack: error.stack,
    });
    Sentry.captureException(error, { tags, extra: { requestId, billId } });
    const incident = await paymentsIncident(
      typeof devinEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devinEmail) ? devinEmail : `oncall/c/${SKIN}`
    );
    return {
      statusCode: 503,
      body: {
        success: false,
        code: 'PAYMENTS_UNAVAILABLE',
        error: 'We can\u2019t process payments right now. Your payment was not taken.',
        requestId,
        bill: BILL,
        incident,
      },
    };
  }
}

module.exports = { BILL, PAYMENT_METHODS, submitPayment };
