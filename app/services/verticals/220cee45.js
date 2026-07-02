const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Thermo Fisher Scientific lab product catalog — life-sciences SKUs
 * (catalog numbers) spanning reagents, antibodies, instruments, and
 * consumables. Cold-chain items ship on dry ice / gel packs.
 */
const CATALOG = [
  { catalogNo: 'A11122', name: 'Alexa Fluor 488 Goat anti-Rabbit IgG', brand: 'Invitrogen', category: 'antibodies', coldChain: true, unitPrice: 489.0 },
  { catalogNo: '15140122', name: 'Penicillin-Streptomycin (10,000 U/mL)', brand: 'Gibco', category: 'cell-culture', coldChain: true, unitPrice: 41.5 },
  { catalogNo: '11668019', name: 'Lipofectamine 2000 Transfection Reagent', brand: 'Invitrogen', category: 'reagents', coldChain: true, unitPrice: 612.0 },
  { catalogNo: '4368814', name: 'High-Capacity cDNA Reverse Transcription Kit', brand: 'Applied Biosystems', category: 'pcr', coldChain: true, unitPrice: 1024.0 },
  { catalogNo: 'AM9937', name: 'Nuclease-Free Water (not DEPC-Treated)', brand: 'Invitrogen', category: 'reagents', coldChain: false, unitPrice: 58.25 },
  { catalogNo: '05-408-129', name: 'Nunc 96-Well MicroWell Plates, Flat Bottom', brand: 'Thermo Scientific', category: 'consumables', coldChain: false, unitPrice: 196.4 },
  { catalogNo: '51119000', name: 'Sorvall Legend Micro 21 Microcentrifuge', brand: 'Thermo Scientific', category: 'instruments', coldChain: false, unitPrice: 4385.0 },
];

/**
 * Regional distribution centers fulfilling lab orders.
 */
const DISTRIBUTION_CENTERS = [
  { id: 'DC-FRMD', name: 'Thermo Fisher DC — Frederick', location: 'Frederick, MD', region: 'northeast', leadDays: 1, status: 'optimal' },
  { id: 'DC-GRND', name: 'Thermo Fisher DC — Grand Island', location: 'Grand Island, NY', region: 'northeast', leadDays: 1, status: 'optimal' },
  { id: 'DC-CARL', name: 'Thermo Fisher DC — Carlsbad', location: 'Carlsbad, CA', region: 'west', leadDays: 2, status: 'low-stock' },
  { id: 'DC-FAIR', name: 'Thermo Fisher DC — Fair Lawn', location: 'Fair Lawn, NJ', region: 'northeast', leadDays: 1, status: 'optimal' },
  { id: 'DC-ROCK', name: 'Thermo Fisher DC — Rockford', location: 'Rockford, IL', region: 'midwest', leadDays: 2, status: 'optimal' },
];

/**
 * Look up a catalog product by its catalog number and compute the
 * extended (line-level) price for the requested quantity.
 * BUG: line items whose catalogNo is not present in CATALOG resolve to
 * `undefined`, so `product.unitPrice` throws a TypeError. The default
 * cart includes catalog number "A14906" (a discontinued antibody SKU
 * that was never migrated into the catalog), which triggers the crash.
 */
function priceLineItem(item) {
  const product = CATALOG.find((p) => p.catalogNo === item.catalogNo);
  const quantity = item.quantity || 1;
  return {
    catalogNo: item.catalogNo,
    name: product.name,
    brand: product.brand,
    unitPrice: product.unitPrice,
    quantity,
    coldChain: product.coldChain,
    extended: Math.round(product.unitPrice * quantity * 100) / 100,
  };
}

/**
 * Aggregate order-level totals from the priced line items.
 */
function aggregateOrder(lineItems) {
  const subtotal = lineItems.reduce((s, li) => s + li.extended, 0);
  const coldChainItems = lineItems.filter((li) => li.coldChain).length;
  const coldChainFee = coldChainItems > 0 ? 35.0 : 0;
  const tax = Math.round(subtotal * 0.07 * 100) / 100;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    coldChainItems,
    coldChainFee,
    tax,
    total: Math.round((subtotal + coldChainFee + tax) * 100) / 100,
  };
}

/**
 * Build the order confirmation payload.
 */
function formatConfirmation(data, lineItems, totals) {
  return {
    orderId: `TF-${Date.now()}`,
    poNumber: data.poNumber,
    accountId: data.accountId,
    distributionCenter: data.distributionCenter,
    lineItems,
    subtotal: totals.subtotal.toFixed(2),
    coldChainFee: totals.coldChainFee.toFixed(2),
    tax: totals.tax.toFixed(2),
    total: totals.total.toFixed(2),
    placedAt: new Date().toISOString(),
  };
}

/**
 * Process a lab-supplies purchase order: price each line item against the
 * product catalog, aggregate totals, and return an order confirmation.
 */
async function processOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing lab supplies order', {
    orderId,
    poNumber: data.poNumber,
    accountId: data.accountId,
    itemCount: (data.items || []).length,
    service: 'thermofisher-order-management',
    route: '/api/220cee45/order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const lineItems = (data.items || []).map(priceLineItem);
    const totals = aggregateOrder(lineItems);
    const confirmation = formatConfirmation(data, lineItems, totals);

    const duration = Date.now() - startTime;

    incrementMetric('order.success', {
      route: '/api/220cee45/order',
      dc: data.distributionCenter || 'auto',
    });
    recordTiming('order.latency', duration, {
      route: '/api/220cee45/order',
    });

    return {
      success: true,
      orderId,
      confirmation,
      status: 'submitted',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.failure', {
      route: '/api/220cee45/order',
      errorClass: error.name,
    });
    recordTiming('order.latency', duration, {
      route: '/api/220cee45/order',
      error: 'true',
    });

    logger.error('Lab supplies order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      poNumber: data.poNumber,
      accountId: data.accountId,
      service: 'thermofisher-order-management',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/220cee45/order',
        service: 'thermofisher-order-management',
        dc: data.distributionCenter || 'auto',
      },
      extra: {
        orderId,
        poNumber: data.poNumber,
        accountId: data.accountId,
        items: data.items,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/220cee45.js \u2014 priceLineItem',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'thermofisher-order-management',
      verticalLabel: 'Thermo Fisher Lab Supplies Order',
      customer: '220cee45',
      tags: [
        { key: 'route', value: '/api/220cee45/order' },
        { key: 'service', value: 'thermofisher-order-management' },
      ],
      extra: { orderId, poNumber: data.poNumber, accountId: data.accountId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'thermofisher-order-management@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from lab order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processOrder, priceLineItem, aggregateOrder, CATALOG, DISTRIBUTION_CENTERS };
