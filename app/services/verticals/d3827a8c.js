const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'atob-fuel-checkout';
const ROUTE = '/api/d3827a8c/checkout';
const SLACK_MEMBER_ID = process.env.ATOB_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Fuel & fleet products that can be authorized on an AtoB card at the pump.
 */
const FUEL_PRODUCTS = [
  { id: 'DSL-2-ULSD', name: 'Diesel #2 (ULSD)', unit: 'gal', category: 'tractor-fuel' },
  { id: 'DSL-RFR', name: 'Reefer Diesel (off-road)', unit: 'gal', category: 'reefer-fuel' },
  { id: 'DEF-BULK', name: 'Diesel Exhaust Fluid', unit: 'gal', category: 'fluids' },
  { id: 'GAS-REG', name: 'Unleaded Regular', unit: 'gal', category: 'fleet-fuel' },
  { id: 'SVC-WASH', name: 'Blue Beacon Tractor Wash', unit: 'ea', category: 'services' },
];

/**
 * Truck stops in the fleet's lane. In-network stations carry a negotiated
 * per-gallon discount on tractor diesel through the AtoB Discount Network.
 */
const STATIONS = {
  'TA-JOLIET-IL': {
    id: 'TA-JOLIET-IL',
    name: 'TA Petro Joliet',
    address: 'I-80 Exit 132, Joliet, IL 60436',
    inNetwork: true,
    discountPerGallon: 0.42,
    discountSku: 'ATOB-NETDISC-TA',
    salesTaxRate: 0.0625,
  },
  'CIRCLEK-GARY-IN': {
    id: 'CIRCLEK-GARY-IN',
    name: 'Circle K #2741',
    address: 'I-94 Exit 15, Gary, IN 46406',
    inNetwork: true,
    discountPerGallon: 0.31,
    discountSku: 'ATOB-NETDISC-CK',
    salesTaxRate: 0.07,
  },
  'IND-MORRIS-IL': {
    id: 'IND-MORRIS-IL',
    name: "Rocky's Truck Plaza (out of network)",
    address: 'I-80 Exit 112, Morris, IL 60450',
    inNetwork: false,
    discountPerGallon: 0,
    discountSku: null,
    salesTaxRate: 0.0625,
  },
};

/**
 * Fleet accounts on AtoB fuel card credit lines.
 */
const FLEET_ACCOUNTS = {
  'FLT-48213': {
    id: 'FLT-48213',
    carrier: 'Ridgeway Freight LLC',
    creditLimit: 25000,
    balance: 6842.17,
    card: { last4: '7652', driver: 'Marcus Bell', unit: 'Truck 214' },
  },
};

function resolveStation(stationId) {
  return Object.hasOwn(STATIONS, stationId) ? STATIONS[stationId] : null;
}

function resolveFleet(fleetId) {
  return Object.hasOwn(FLEET_ACCOUNTS, fleetId) ? FLEET_ACCOUNTS[fleetId] : null;
}

function isKnownProduct(sku) {
  return FUEL_PRODUCTS.some((p) => p.id === sku);
}

/**
 * Appends the AtoB Discount Network rebate for in-network stations so it
 * shows up as its own line on the fuel receipt.
 */
function applyNetworkDiscounts(items, station) {
  if (!station.inNetwork) return [...items];
  const dieselGallons = items
    .filter((item) => item.sku === 'DSL-2-ULSD')
    .reduce((sum, item) => sum + item.qty, 0);
  if (dieselGallons <= 0) return [...items];
  return [
    ...items,
    { sku: station.discountSku, qty: dieselGallons, price: -station.discountPerGallon },
  ];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeTotals(lines, station) {
  const gross = lines.filter((l) => l.price > 0).reduce((s, l) => s + l.price * l.qty, 0);
  const savings = lines.filter((l) => l.price < 0).reduce((s, l) => s - l.price * l.qty, 0);
  const net = gross - savings;
  const tax = net * station.salesTaxRate;
  return {
    gross: round2(gross),
    savings: round2(savings),
    tax: round2(tax),
    total: round2(net + tax),
  };
}

/**
 * Formats the fuel receipt lines shown in the driver app and on the statement.
 */
function formatFuelReceipt(lines) {
  return lines.map((line) => {
    const product = FUEL_PRODUCTS.find((p) => p.id === line.sku);
    return {
      sku: line.sku,
      name: product.name,
      unit: product.unit,
      qty: line.qty,
      unitPrice: line.price,
      lineTotal: round2(line.price * line.qty),
    };
  });
}

/**
 * Authorizes a prepaid fuel purchase on an AtoB fuel card.
 */
async function processFuelCheckout(data) {
  const startTime = Date.now();
  const authorizationId = `AUTH-${uuidv4().slice(0, 8).toUpperCase()}`;
  const station = resolveStation(data.stationId);
  const fleet = resolveFleet(data.fleetId);

  logger.info('Processing AtoB fuel checkout', {
    authorizationId,
    fleetId: data.fleetId,
    stationId: data.stationId,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const lines = applyNetworkDiscounts(data.items, station);
    const totals = computeTotals(lines, station);

    const available = round2(fleet.creditLimit - fleet.balance);
    if (totals.total > available) {
      throw Object.assign(
        new Error(`Purchase of $${totals.total.toFixed(2)} exceeds available credit of $${available.toFixed(2)}`),
        { name: 'CreditLimitError', code: 'INSUFFICIENT_CREDIT', status: 402 },
      );
    }

    const receipt = formatFuelReceipt(lines);
    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', { route: ROUTE, source: 'atob-dashboard' });
    recordTiming('checkout.latency', duration, { route: ROUTE });

    return {
      success: true,
      authorizationId,
      station: { id: station.id, name: station.name },
      card: `**** ${fleet.card.last4}`,
      ...totals,
      availableCreditAfter: round2(available - totals.total),
      receipt,
      status: 'authorized',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error.code === 'INSUFFICIENT_CREDIT') throw error;

    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', { route: ROUTE, errorClass: error.name, source: 'atob-dashboard' });
    recordTiming('checkout.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('AtoB fuel checkout failed', {
      authorizationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      fleetId: data.fleetId,
      stationId: data.stationId,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'atob-dashboard', station: String(data.stationId) },
      extra: { authorizationId, fleetId: data.fleetId, stationId: data.stationId, items: data.items },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/d3827a8c.js \u2014 formatFuelReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'd3827a8c',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'AtoB \u2014 Fuel Card Checkout',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'station', value: String(data.stationId) },
      ],
      extra: { authorizationId, fleetId: data.fleetId, stationId: data.stationId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@3.18.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from AtoB fuel checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  processFuelCheckout,
  applyNetworkDiscounts,
  computeTotals,
  formatFuelReceipt,
  resolveStation,
  resolveFleet,
  isKnownProduct,
  FUEL_PRODUCTS,
  STATIONS,
  FLEET_ACCOUNTS,
};
