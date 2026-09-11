const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/fd7f4e04/orders';
const SERVICE = 'carvana-checkout-financing';

/**
 * Vehicles available for purchase in the demo inventory.
 */
const INVENTORY = {
  'cvna-2286413': {
    year: 2022,
    make: 'Tesla',
    model: 'Model 3',
    trim: 'Long Range AWD',
    bodyStyle: 'electric',
    mileage: 24812,
    price: 29990,
    kbbDelta: -1810,
    location: 'Tempe, AZ',
  },
  'cvna-2311907': {
    year: 2021,
    make: 'Toyota',
    model: 'RAV4 Hybrid',
    trim: 'XLE',
    bodyStyle: 'suv',
    mileage: 31405,
    price: 27590,
    kbbDelta: -1520,
    location: 'Phoenix, AZ',
  },
  'cvna-2203344': {
    year: 2020,
    make: 'Ford',
    model: 'F-150',
    trim: 'XLT SuperCrew',
    bodyStyle: 'truck',
    mileage: 42118,
    price: 32990,
    kbbDelta: -2240,
    location: 'Tolleson, AZ',
  },
  'cvna-2298760': {
    year: 2022,
    make: 'Honda',
    model: 'Civic',
    trim: 'EX',
    bodyStyle: 'sedan',
    mileage: 18230,
    price: 22590,
    kbbDelta: -980,
    location: 'Tempe, AZ',
  },
};

/**
 * Loan terms the checkout UI lets a buyer pick from.
 */
const FINANCING_TERMS = [36, 48, 60, 72, 84];

/**
 * Credit tiers from the pre-qualification step.
 */
const CREDIT_TIERS = {
  excellent: { label: 'Excellent (760+)', minScore: 760 },
  good: { label: 'Good (700–759)', minScore: 700 },
  fair: { label: 'Fair (640–699)', minScore: 640 },
  rebuilding: { label: 'Rebuilding (under 640)', minScore: 0 },
};

/**
 * Annual percentage rate by credit tier and loan term.
 * BUG: the 72-month term was added to the checkout UI (and FINANCING_TERMS)
 * but never to this table, so every tier resolves `undefined` for 72.
 */
const APR_TABLE = {
  excellent: {
    36: { apr: 6.49 },
    48: { apr: 6.79 },
    60: { apr: 6.99 },
    84: { apr: 7.99 },
  },
  good: {
    36: { apr: 8.24 },
    48: { apr: 8.49 },
    60: { apr: 8.89 },
    84: { apr: 9.99 },
  },
  fair: {
    36: { apr: 11.49 },
    48: { apr: 11.99 },
    60: { apr: 12.49 },
    84: { apr: 13.99 },
  },
  rebuilding: {
    36: { apr: 16.99 },
    48: { apr: 17.49 },
    60: { apr: 17.99 },
    84: { apr: 19.49 },
  },
};

/**
 * How the buyer takes delivery of the vehicle.
 */
const DELIVERY_OPTIONS = {
  home_delivery: { label: 'Home delivery', fee: 0, leadTimeDays: 3 },
  vending_machine: { label: 'Pick up at a Carvana Vending Machine', fee: 0, leadTimeDays: 2 },
  shipped: { label: 'Shipped from another market', fee: 590, leadTimeDays: 9 },
};

/**
 * CarvanaCare protection plans offered at checkout.
 */
const PROTECTION_PLANS = {
  none: { label: 'No protection plan', price: 0 },
  carvanacare_essential: { label: 'CarvanaCare Essential', price: 1299, coverage: '36 mo / 36K mi' },
  carvanacare_plus: { label: 'CarvanaCare Plus', price: 2199, coverage: '60 mo / 60K mi' },
};

const SALES_TAX_RATE = 0.083;

/**
 * Resolves the vehicle for an order.
 */
function resolveVehicle(vehicleId) {
  const vehicle = INVENTORY[vehicleId];
  if (!vehicle) {
    throw Object.assign(new Error(`Vehicle not in inventory: ${vehicleId}`), { code: 'INVALID_VEHICLE' });
  }
  return vehicle;
}

/**
 * Computes the out-the-door price for the order.
 */
function computeOrderTotal(vehicle, deliveryMethod, protectionPlan) {
  const delivery = DELIVERY_OPTIONS[deliveryMethod];
  const protection = PROTECTION_PLANS[protectionPlan];
  const salesTax = Math.round(vehicle.price * SALES_TAX_RATE * 100) / 100;
  return {
    vehiclePrice: vehicle.price,
    salesTax,
    deliveryFee: delivery.fee,
    protectionPrice: protection.price,
    total: Math.round((vehicle.price + salesTax + delivery.fee + protection.price) * 100) / 100,
  };
}

/**
 * Amortized monthly payment for a fixed-rate loan.
 */
function monthlyPayment(principal, apr, termMonths) {
  if (principal <= 0) return 0;
  const r = apr / 100 / 12;
  if (r === 0) return principal / termMonths;
  return (principal * r) / (1 - Math.pow(1 + r, -termMonths));
}

/**
 * Builds the financing terms for the order.
 * BUG: APR_TABLE has no 72-month row, so `rate.apr` crashes.
 */
function computeFinancing(totals, downPayment, tradeInValue, termMonths, creditTier) {
  const rate = APR_TABLE[creditTier][termMonths];
  const amountFinanced = Math.max(totals.total - downPayment - tradeInValue, 0);
  const payment = monthlyPayment(amountFinanced, rate.apr, termMonths);
  const totalOfPayments = payment * termMonths;
  return {
    apr: rate.apr,
    termMonths,
    downPayment,
    tradeInValue,
    amountFinanced: Math.round(amountFinanced * 100) / 100,
    monthlyPayment: Math.round(payment * 100) / 100,
    totalInterest: Math.round((totalOfPayments - amountFinanced) * 100) / 100,
    lender: 'Carvana Financing',
  };
}

function estimatedDeliveryDate(deliveryMethod) {
  const d = new Date();
  d.setDate(d.getDate() + DELIVERY_OPTIONS[deliveryMethod].leadTimeDays);
  return d.toISOString().slice(0, 10);
}

/**
 * Places a vehicle purchase order with financing.
 */
async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Placing Carvana purchase order', {
    orderId,
    vehicleId: data.vehicleId,
    termMonths: data.termMonths,
    creditTier: data.creditTier,
    deliveryMethod: data.deliveryMethod,
    protectionPlan: data.protectionPlan,
    zipCode: data.zipCode,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const vehicle = resolveVehicle(data.vehicleId);
    const totals = computeOrderTotal(vehicle, data.deliveryMethod, data.protectionPlan);
    const financing = computeFinancing(totals, data.downPayment, data.tradeInValue, data.termMonths, data.creditTier);

    const duration = Date.now() - startTime;

    incrementMetric('order.place.success', {
      route: ROUTE,
      term: String(data.termMonths),
      creditTier: data.creditTier,
      deliveryMethod: data.deliveryMethod,
    });
    recordTiming('order.place.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      buyerName: data.buyerName,
      vehicle: {
        vehicleId: data.vehicleId,
        title: `${vehicle.year} ${vehicle.make} ${vehicle.model} ${vehicle.trim}`,
        mileage: vehicle.mileage,
        location: vehicle.location,
      },
      totals,
      financing,
      delivery: {
        method: data.deliveryMethod,
        label: DELIVERY_OPTIONS[data.deliveryMethod].label,
        zipCode: data.zipCode,
        estimatedDate: estimatedDeliveryDate(data.deliveryMethod),
      },
      protection: {
        plan: data.protectionPlan,
        label: PROTECTION_PLANS[data.protectionPlan].label,
      },
      status: 'pending_verification',
      nextStep: 'Upload your driver\u2019s license and proof of insurance to lock in your delivery date.',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.place.failure', {
      route: ROUTE,
      errorClass: error.name,
      term: String(data.termMonths),
      creditTier: data.creditTier,
    });
    recordTiming('order.place.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Carvana purchase order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      vehicleId: data.vehicleId,
      termMonths: data.termMonths,
      creditTier: data.creditTier,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'carvana-checkout' },
      extra: {
        orderId,
        vehicleId: data.vehicleId,
        termMonths: data.termMonths,
        creditTier: data.creditTier,
        deliveryMethod: data.deliveryMethod,
        protectionPlan: data.protectionPlan,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/fd7f4e04.js \u2014 computeFinancing',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'fd7f4e04',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Carvana — Checkout & Financing',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        orderId,
        vehicleId: data.vehicleId,
        termMonths: data.termMonths,
        creditTier: data.creditTier,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Carvana checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  resolveVehicle,
  computeOrderTotal,
  computeFinancing,
  monthlyPayment,
  INVENTORY,
  FINANCING_TERMS,
  CREDIT_TIERS,
  APR_TABLE,
  DELIVERY_OPTIONS,
  PROTECTION_PLANS,
};
