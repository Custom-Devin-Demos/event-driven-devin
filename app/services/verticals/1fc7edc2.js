const crypto = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const { runWithAlertDestination } = require('../alert-destination');
const logger = require('../../telemetry/logger');

const CUSTOMER = '1fc7edc2';
const SERVICE = 'customer-1fc7edc2-installment-plans';
const ROUTE = 'POST /api/1fc7edc2/installment-plans';
const CULPRIT = 'app/services/verticals/1fc7edc2.js — toBillingAmount';
const ERROR_CODE = 'ISR-INS-4221';
const VERTICAL_LABEL = 'Isracard — Spread a charge into installments';
const ALERT_COOLDOWN_MS = Number(process.env.ISRACARD_ALERT_COOLDOWN_MS || 60000);

const CARD = {
  id: 'card-4417', product: 'FLY CARD', network: 'American Express', last4: '4417', holder: 'דנה כהן',
  billingDate: '2026-12-10', creditLimit: 28000, usedCredit: 9640,
};

// Charges awaiting the next billing date. Foreign charges are converted to ILS on the billing date.
const CHARGES = [
  { id: 'ch-81f3', merchant: 'CENTARA GRAND BEACH PHUKET', city: 'PHUKET', country: 'TH', date: '2026-11-14', amount: 38900, currency: 'THB', category: 'מלונות ותיירות' },
  { id: 'ch-77a0', merchant: 'BOOKING.COM AMSTERDAM', city: 'AMSTERDAM', country: 'NL', date: '2026-11-08', amount: 1140, currency: 'EUR', category: 'מלונות ותיירות' },
  { id: 'ch-6c21', merchant: 'אל על נתיבי אויר לישראל', city: 'לוד', country: 'IL', date: '2026-11-03', amount: 4820, currency: 'ILS', category: 'תעופה' },
  { id: 'ch-5b9e', merchant: 'B&H PHOTO NEW YORK', city: 'NEW YORK', country: 'US', date: '2026-10-29', amount: 1489, currency: 'USD', category: 'אלקטרוניקה' },
  { id: 'ch-4d02', merchant: 'KSP מחשבים', city: 'תל אביב', country: 'IL', date: '2026-10-27', amount: 3290, currency: 'ILS', category: 'אלקטרוניקה' },
  { id: 'ch-3a17', merchant: 'שופרסל דיל רמת השרון', city: 'רמת השרון', country: 'IL', date: '2026-10-25', amount: 412.4, currency: 'ILS', category: 'מזון וצריכה' },
];

// Bank of Israel representative rates (ILS per 1 unit), published 2026-11-20.
const REPRESENTATIVE_RATES = {
  USD: { rate: 3.712, publishedAt: '2026-11-20' },
  EUR: { rate: 3.921, publishedAt: '2026-11-20' },
  GBP: { rate: 4.684, publishedAt: '2026-11-20' },
  CHF: { rate: 4.198, publishedAt: '2026-11-20' },
  JPY: { rate: 0.02412, publishedAt: '2026-11-20' },
  CAD: { rate: 2.659, publishedAt: '2026-11-20' },
  AUD: { rate: 2.418, publishedAt: '2026-11-20' },
};

// Currencies with no representative rate are converted via USD: units per 1 USD (Isracard treasury, 2026-11-20).
const CROSS_RATES = {
  THB: { perUsd: 34.62, publishedAt: '2026-11-20' },
  TRY: { perUsd: 34.18, publishedAt: '2026-11-20' },
  GEL: { perUsd: 2.731, publishedAt: '2026-11-20' },
  VND: { perUsd: 25410, publishedAt: '2026-11-20' },
};

const PAYMENT_OPTIONS = [3, 6, 10, 12, 18, 24, 36];
// Annual interest by plan length (indicative, before personal pricing).
const PLAN_RATES = [
  { maxPayments: 6, annualRate: 6.9 },
  { maxPayments: 12, annualRate: 8.9 },
  { maxPayments: 24, annualRate: 10.9 },
  { maxPayments: 36, annualRate: 11.9 },
];
const MIN_SPREAD_ILS = 500;

const REMEDIATION_DIRECTIVE = [
  'Repository: COG-GTM/event-driven-devin. Open a ready-for-review (not draft) pull request against main with a conventional title (e.g. "fix(installment-plans): ..."); never merge or deploy.',
  'FIRST, before reading any code: reply in the alert\'s Slack thread (channel and thread_ts are at the end of this prompt; curl chat.postMessage with $SLACK_BOT_TOKEN) with your Devin session link only, e.g. ":robot_face: Investigating — <your session URL>".',
  'Treat this alert as a new incident even if the same error alerted before: do not look for, wait on, reuse or link earlier alerts, threads, sessions, branches or PRs.',
  'Customer impact: Isracard "פריסת חיובים" (/isracard#spread) returns HTTP 500 ' + ERROR_CODE + ' when a cardholder spreads a pending charge made in Thai baht (THB) into installments. ILS, USD and EUR charges spread successfully.',
  'Reproduce: open /isracard?reports=off#spread, keep the pre-selected charge (CENTARA GRAND BEACH PHUKET, ฿38,900) and 12 payments, and press "לאישור הפריסה". Pick the Booking.com (EUR) charge and the same request succeeds.',
  'Inspect app/services/verticals/1fc7edc2.js (toBillingAmount, REPRESENTATIVE_RATES, CROSS_RATES, requestPlan), app/routes/verticals/1fc7edc2.js and app/public/verticals/1fc7edc2-assets/spread.js. Find and state the root cause before changing code.',
  'Business rule: currencies without a Bank of Israel representative rate are converted through USD — divide by CROSS_RATES[currency].perUsd, then multiply by the USD representative rate — and the plan reports which rate path it used. An unknown currency must be a clear 4xx, not a 500.',
  'Keep every payment option, the plan-rate tiers, the ₪500 minimum, error reporting and the server-generated plan reference intact.',
  'Add regression coverage in tests/1fc7edc2-isracard-installments.test.js and update the existing failure expectation after the fix. Run npx jest tests/1fc7edc2-isracard-installments.test.js and npm run lint.',
  'Do not disable Sentry/alerts, swallow the error, hide THB charges from the list, or fake a successful response in the browser.',
  'After opening the PR, request Devin Review on it and wait for the Devin Review checks to finish; fix every actionable finding on the same branch and reply to each review comment. Then post a short root-cause + PR + Devin Review summary to the Slack thread and stop for human approval.',
].join('\n');

const MAX_STORED_PLANS = 500;
const plans = new Map();
let lastAlertAt = 0;
const invalid = (message, field) => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_INSTALLMENT_REQUEST', field });
const round2 = n => Math.round(n * 100) / 100;

function getAccount() {
  return {
    card: { ...CARD, availableCredit: CARD.creditLimit - CARD.usedCredit },
    charges: CHARGES.map(c => ({ ...c })),
    paymentOptions: PAYMENT_OPTIONS,
    minSpread: MIN_SPREAD_ILS,
  };
}

function validateRequest(input = {}) {
  const charge = CHARGES.find(c => c.id === input.chargeId);
  if (!charge) throw invalid('יש לבחור עסקה לפריסה.', 'chargeId');
  const payments = Number(input.payments);
  if (!PAYMENT_OPTIONS.includes(payments)) throw invalid('יש לבחור מספר תשלומים.', 'payments');
  return { charge, payments };
}

// Converts a pending charge to the ILS amount that will be billed.
function toBillingAmount(charge) {
  if (charge.currency === 'ILS') return { amount: round2(charge.amount), rate: 1, ratePath: 'ILS' };
  const rate = REPRESENTATIVE_RATES[charge.currency].rate;
  return { amount: round2(charge.amount * rate), rate, ratePath: 'REPRESENTATIVE' };
}

function planRate(payments) {
  return PLAN_RATES.find(t => payments <= t.maxPayments).annualRate;
}

function monthlyPayment(principal, annualRate, payments) {
  const r = annualRate / 100 / 12;
  if (r === 0) return principal / payments;
  return (principal * r) / (1 - (1 + r) ** -payments);
}

function remember(id, plan) {
  plans.set(id, plan);
  if (plans.size > MAX_STORED_PLANS) plans.delete(plans.keys().next().value);
}

function reportFailure(error, context, data) {
  const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, error_code: ERROR_CODE, alert_path: 'instant' };
  Sentry.captureException(error, { tags, extra: context });
  logger.error('Installment plan pricing failed', { ...context, service: SERVICE, error: error.message });
  if (data.suppressAlerts) return;
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.info('Installment plan alert skipped (cooldown)', { service: SERVICE, planId: context.planId });
    return;
  }
  lastAlertAt = now;
  logger.info('Posting alert and triggering Devin', { service: SERVICE, planId: context.planId });
  // Isracard alerts always go to #oncall-alerts, whatever destination the hub cookie picked.
  runWithAlertDestination('slack', () => createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: CULPRIT, errorType: error.name, errorValue: error.message,
    customer: CUSTOMER, service: SERVICE, verticalLabel: VERTICAL_LABEL,
    level: 'error', platform: 'node', release: 'installment-plans@2026.11.4', environment: process.env.DD_ENV || 'prod',
    skipVulnerablePr: true,
    promptAppendix: `Incident Ref: ${context.planId}\n${REMEDIATION_DIRECTIVE}`,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
  })).catch(err => logger.error('Failed to create Devin session for installment plan failure', { error: err.message, planId: context.planId }));
}

async function requestPlan(data = {}, now = new Date()) {
  const { charge, payments } = validateRequest(data);
  let planId;
  do planId = `IC-${now.getUTCFullYear()}-${String(crypto.randomInt(0, 1e7)).padStart(7, '0')}`; while (plans.has(planId));
  try {
    const billing = toBillingAmount(charge);
    if (billing.amount < MIN_SPREAD_ILS) throw invalid(`ניתן לפרוס עסקאות בסכום של ₪${MIN_SPREAD_ILS} ומעלה.`, 'chargeId');
    const annualRate = planRate(payments);
    const monthly = round2(monthlyPayment(billing.amount, annualRate, payments));
    const totalCost = round2(monthly * payments);
    const plan = {
      success: true, planId, status: 'APPROVED', chargeId: charge.id, merchant: charge.merchant,
      originalAmount: charge.amount, currency: charge.currency, billingAmount: billing.amount, exchangeRate: billing.rate, ratePath: billing.ratePath,
      payments, annualRate, monthlyPayment: monthly, totalCost, totalInterest: round2(totalCost - billing.amount),
      firstPaymentDate: CARD.billingDate, card: { product: CARD.product, last4: CARD.last4 }, firstName: CARD.holder.split(/\s+/)[0],
    };
    remember(planId, plan);
    logger.info('Installment plan approved', { service: SERVICE, planId, currency: charge.currency, payments, billingAmount: billing.amount });
    return plan;
  } catch (error) {
    if (error.name === 'ValidationError') throw error;
    const context = {
      planId, chargeId: charge.id, merchantCountry: charge.country, currency: charge.currency,
      originalAmount: charge.amount, payments, card: CARD.product, errorCode: ERROR_CODE,
    };
    reportFailure(error, context, data);
    throw Object.assign(error, { status: 500, code: ERROR_CODE, reference: planId });
  }
}

function getPlan(planId) {
  const plan = typeof planId === 'string' ? plans.get(planId) : undefined;
  if (!plan) throw Object.assign(new Error('הפריסה לא נמצאה.'), { name: 'NotFoundError', status: 404, code: 'PLAN_NOT_FOUND' });
  return plan;
}

function resetAlertCooldown() { lastAlertAt = 0; }

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, ERROR_CODE, CARD, CHARGES, REPRESENTATIVE_RATES, CROSS_RATES, PAYMENT_OPTIONS, PLAN_RATES,
  MIN_SPREAD_ILS, REMEDIATION_DIRECTIVE, getAccount, validateRequest, toBillingAmount, planRate, monthlyPayment, requestPlan, getPlan, resetAlertCooldown,
};
