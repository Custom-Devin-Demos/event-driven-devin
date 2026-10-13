const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-f7eb28ad-store-order-billing';
const ROUTE = '/api/f7eb28ad/order/create';
const ORDER_PREFIX = 'UTY-ORD';
const PRODUCT = 'UTY-EDITION-PRO';
const MAX_SEATS = 200;

/**
 * Store variants for Unity Pro as exposed to unity.com/products/unity-pro
 * (`service-store.unity.com/order/create?product=UTY-EDITION-PRO&variant=...`).
 * Each variant points at the billing rate plan that invoices it.
 *
 * 2026 Unity Pro price update: the "paid monthly" variant was re-pointed at the
 * new RP-PRO-ANNUAL-MONTHLY-2026 rate plan when the $210/seat list price went
 * live. Its installment schedule is supposed to arrive with the next billing
 * rate-plan sync.
 */
const PLAN_VARIANTS = {
  'unity-pro-1-year-prepaid': {
    label: 'Annual plan, prepaid yearly',
    billingTerm: 'prepaid',
    unitPriceUsd: 2310,
    interval: 'yr',
    ratePlanId: 'RP-PRO-ANNUAL-PREPAID',
  },
  'unity-pro-1-year-monthly': {
    label: 'Annual plan, paid monthly',
    billingTerm: 'installment',
    unitPriceUsd: 210,
    interval: 'mo',
    ratePlanId: 'RP-PRO-ANNUAL-MONTHLY-2026',
  },
};

/**
 * Installment schedules mirrored from the billing system, keyed by rate plan.
 * Every installment rate plan referenced by PLAN_VARIANTS must have an entry.
 */
const INSTALLMENT_SCHEDULES = {
  'RP-PRO-ANNUAL-MONTHLY': { installmentCount: 12, commitmentMonths: 12, firstChargeOffsetDays: 0 },
  'RP-ENT-ANNUAL-MONTHLY': { installmentCount: 12, commitmentMonths: 12, firstChargeOffsetDays: 0 },
  'RP-IND-ANNUAL-MONTHLY': { installmentCount: 12, commitmentMonths: 12, firstChargeOffsetDays: 0 },
};

const BILLING_COUNTRIES = {
  US: { label: 'United States', currency: 'USD', taxRate: 0, taxNote: 'Sales tax calculated on invoice' },
  CA: { label: 'Canada', currency: 'USD', taxRate: 0.05, taxNote: 'GST' },
  GB: { label: 'United Kingdom', currency: 'USD', taxRate: 0.2, taxNote: 'VAT' },
  DE: { label: 'Germany', currency: 'USD', taxRate: 0.19, taxNote: 'VAT' },
  FR: { label: 'France', currency: 'USD', taxRate: 0.2, taxNote: 'VAT' },
  JP: { label: 'Japan', currency: 'USD', taxRate: 0.1, taxNote: 'JCT' },
  KR: { label: 'South Korea', currency: 'USD', taxRate: 0.1, taxNote: 'VAT' },
  AU: { label: 'Australia', currency: 'USD', taxRate: 0.1, taxNote: 'GST' },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Unity Pro store checkout vertical:',
  '- Service: `app/services/verticals/f7eb28ad.js`',
  '- Route: `app/routes/verticals/f7eb28ad.js`',
  '- Page: `app/public/verticals/f7eb28ad.html` (served at `/f7eb28ad`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function validateOrder(data) {
  if (data.product !== PRODUCT) throw validationError('Choose a Unity plan.', 'INVALID_PRODUCT');
  if (!PLAN_VARIANTS[data.variant]) throw validationError('Choose a billing option.', 'INVALID_VARIANT');
  if (!Number.isInteger(data.seats) || data.seats < 1) throw validationError('Enter at least 1 seat.', 'INVALID_SEATS');
  if (data.seats > MAX_SEATS) throw validationError(`Online orders are limited to ${MAX_SEATS} seats. Contact Sales for larger teams.`, 'TOO_MANY_SEATS');
  if (!data.organization || data.organization.length > 120) throw validationError('Enter your Unity organization name.', 'INVALID_ORGANIZATION');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email) || data.email.length > 254) throw validationError('Enter a valid billing email address.', 'INVALID_EMAIL');
  if (!BILLING_COUNTRIES[data.country]) throw validationError('Choose your billing country.', 'INVALID_COUNTRY');
  if (data.termsAccepted !== true) throw validationError('Accept the Unity Terms of Service to continue.', 'TERMS_NOT_ACCEPTED');
}

function resolveVariant(variantId) {
  const variant = PLAN_VARIANTS[variantId];
  return {
    variant,
    schedule: variant.billingTerm === 'installment' ? INSTALLMENT_SCHEDULES[variant.ratePlanId] : null,
  };
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * Charge schedule for a 1-year Unity Pro commitment. Prepaid orders are a
 * single charge; paid-monthly orders bill one installment per month.
 */
function buildChargeSchedule(variant, schedule, seats, country, startDate) {
  const { taxRate } = BILLING_COUNTRIES[country];
  if (variant.billingTerm === 'prepaid') {
    const subtotal = roundCents(variant.unitPriceUsd * seats);
    const tax = roundCents(subtotal * taxRate);
    return {
      installments: 1,
      dueToday: roundCents(subtotal + tax),
      perInstallment: roundCents(subtotal + tax),
      annualCommitment: roundCents(subtotal + tax),
      tax,
      renewsOn: addMonths(startDate, 12).toISOString().slice(0, 10),
    };
  }

  const perInstallmentSubtotal = roundCents(variant.unitPriceUsd * seats);
  const perInstallmentTax = roundCents(perInstallmentSubtotal * taxRate);
  const perInstallment = roundCents(perInstallmentSubtotal + perInstallmentTax);
  return {
    installments: schedule.installmentCount,
    dueToday: perInstallment,
    perInstallment,
    annualCommitment: roundCents(perInstallment * schedule.installmentCount),
    tax: roundCents(perInstallmentTax * schedule.installmentCount),
    renewsOn: addMonths(startDate, schedule.commitmentMonths).toISOString().slice(0, 10),
  };
}

async function createOrder(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const normalized = {
    ...data,
    product: String(data.product ?? '').trim().toUpperCase(),
    variant: String(data.variant ?? '').trim().toLowerCase(),
    seats: Number(data.seats),
    organization: String(data.organization ?? '').trim(),
    email: String(data.email ?? '').trim(),
    country: String(data.country ?? '').trim().toUpperCase(),
    termsAccepted: data.termsAccepted === true,
  };

  validateOrder(normalized);

  logger.info('Creating Unity Store order', {
    requestId,
    product: normalized.product,
    variant: normalized.variant,
    seats: normalized.seats,
    country: normalized.country,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const createdAt = new Date();
    const { variant, schedule } = resolveVariant(normalized.variant);
    const charges = buildChargeSchedule(variant, schedule, normalized.seats, normalized.country, createdAt);
    const orderId = `${ORDER_PREFIX}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const duration = Date.now() - startTime;

    incrementMetric('store.order_created', {
      route: ROUTE,
      product: normalized.product,
      variant: normalized.variant,
      rate_plan: variant.ratePlanId,
    });
    recordTiming('store.order_latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      product: 'Unity Pro',
      variant: variant.label,
      seats: normalized.seats,
      country: BILLING_COUNTRIES[normalized.country].label,
      currency: 'USD',
      ...charges,
      createdAt: createdAt.toISOString(),
      message: `Your Unity Pro seats are ready to assign in Unity Cloud. Plan renews on ${charges.renewsOn}.`,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('store.order_failure', {
      route: ROUTE,
      errorClass: error.name,
      product: normalized.product,
      variant: normalized.variant,
    });
    recordTiming('store.order_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Unity Store order creation failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      product: normalized.product,
      variant: normalized.variant,
      seats: normalized.seats,
      country: normalized.country,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        product: normalized.product,
        variant: normalized.variant,
        country: normalized.country,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        product: normalized.product,
        variant: normalized.variant,
        seats: normalized.seats,
        country: normalized.country,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f7eb28ad.js \u2014 buildChargeSchedule',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: normalized.devinUserId,
      devinEmail: normalized.devinEmail,
      devinOrgId: normalized.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Unity Store — Unity Pro checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'f7eb28ad',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'product', value: normalized.product },
        { key: 'variant', value: normalized.variant },
        { key: 'country', value: normalized.country },
        { key: 'order_prefix', value: ORDER_PREFIX },
      ],
      extra: {
        requestId,
        product: normalized.product,
        variant: normalized.variant,
        seats: normalized.seats,
        country: normalized.country,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.1.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Unity Store order error', {
        error: alertError.message,
        requestId,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  createOrder,
  resolveVariant,
  buildChargeSchedule,
  PRODUCT,
  PLAN_VARIANTS,
  INSTALLMENT_SCHEDULES,
  BILLING_COUNTRIES,
  REMEDIATION_DIRECTIVE,
};
