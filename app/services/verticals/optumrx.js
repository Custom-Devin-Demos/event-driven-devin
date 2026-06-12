const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Optum Rx formulary — mail-order pharmacy SKUs (90-day home delivery supplies)
 */
const CATALOG = [
  { id: 'RX-ATOR-20', name: 'Atorvastatin 20mg', price: 14.00, category: 'cardiovascular', supply: '90-day supply' },
  { id: 'RX-LISI-10', name: 'Lisinopril 10mg', price: 9.00, category: 'cardiovascular', supply: '90-day supply' },
  { id: 'RX-AMLO-5', name: 'Amlodipine 5mg', price: 7.50, category: 'cardiovascular', supply: '90-day supply' },
  { id: 'RX-METF-500', name: 'Metformin 500mg', price: 8.50, category: 'diabetes', supply: '90-day supply' },
  { id: 'RX-LEVO-50', name: 'Levothyroxine 50mcg', price: 11.00, category: 'thyroid', supply: '90-day supply' },
  { id: 'RX-OMEP-20', name: 'Omeprazole 20mg', price: 10.00, category: 'gastrointestinal', supply: '90-day supply' },
  { id: 'RX-SERT-50', name: 'Sertraline 50mg', price: 13.00, category: 'mental-health', supply: '90-day supply' },
  { id: 'RX-MONT-10', name: 'Montelukast 10mg', price: 15.00, category: 'respiratory', supply: '90-day supply' },
];

/**
 * Pharmacy benefit plan configuration — member coinsurance rate + billing currency
 */
const PLAN_TIERS = {
  STANDARD: { coinsuranceRate: 0.20, currency: 'USD' },
  PREMIUM: { coinsuranceRate: 0.10, currency: 'USD' },
  HDHP: { coinsuranceRate: 0.30, currency: 'USD' },
  MEDICARE: { coinsuranceRate: 0.05, currency: 'USD' },
};

/**
 * Active member benefits — "Home Delivery auto-refill enrollment" credit.
 * Applied server-side so it appears on the order confirmation.
 */
const ACTIVE_BENEFITS = [
  { sku: 'BENEFIT-AUTOREFILL-2026', name: 'Home Delivery Auto-Refill Enrollment', price: 0, qty: 1 },
];

/**
 * Looks up the home-delivery savings tier for a given order subtotal.
 */
function getApplicableSavings(subtotal) {
  if (subtotal >= 200) return { rate: 0.15, label: '15% Home Delivery savings on orders $200+' };
  if (subtotal >= 100) return { rate: 0.10, label: '10% Home Delivery savings on orders $100+' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges active member benefits into the order line items.
 */
function applyBenefits(items) {
  return [...items, ...ACTIVE_BENEFITS];
}

/**
 * Computes the final member responsibility for the prescription order.
 */
function computeOrderTotal(subtotal, plan) {
  const planConfig = PLAN_TIERS[plan];
  if (!planConfig) {
    throw Object.assign(new Error(`Unknown benefit plan: ${plan}`), { code: 'INVALID_PLAN' });
  }
  const coinsurance = subtotal * planConfig.coinsuranceRate;
  const savings = getApplicableSavings(subtotal);
  const savingsAmount = (subtotal + coinsurance) * savings.rate;
  return {
    subtotal,
    coinsurance: Math.round(coinsurance * 100) / 100,
    savings: Math.round(savingsAmount * 100) / 100,
    savingsLabel: savings.label,
    total: Math.round((subtotal + coinsurance - savingsAmount) * 100) / 100,
    currency: planConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 * BUG: BENEFIT-AUTOREFILL-2026 is not in CATALOG, so medication.name crashes.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const medication = CATALOG.find((m) => m.id === item.sku);
    return {
      sku: item.sku,
      name: medication.name,
      category: medication.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes an Optum Rx mail-order prescription order.
 */
async function processPrescriptionOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Optum Rx prescription order', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'optumrx-pharmacy',
    route: '/api/optumrx/order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyBenefits(orderData.items);

    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeOrderTotal(finalSubtotal, orderData.plan);
    const receipt = formatReceipt(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/optumrx/order',
      source: 'optumrx-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/optumrx/order',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      coinsurance: result.coinsurance,
      savings: result.savings,
      savingsLabel: result.savingsLabel,
      receipt,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/optumrx/order',
      errorClass: error.name,
      source: 'optumrx-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/optumrx/order',
      error: 'true',
    });

    logger.error('Optum Rx prescription order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'optumrx-pharmacy',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/optumrx/order',
        service: 'optumrx-pharmacy',
        source: 'optumrx-portal',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        plan: orderData.plan,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/optumrx.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'optumrx-pharmacy',
      verticalLabel: 'Optum Rx Order',
      tags: [
        { key: 'route', value: '/api/optumrx/order' },
        { key: 'service', value: 'optumrx-pharmacy' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'optumrx-pharmacy@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Optum Rx order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processPrescriptionOrder, computeOrderTotal, formatReceipt, applyBenefits, CATALOG, PLAN_TIERS };
