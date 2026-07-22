const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Chipotle "Order Ahead" digital menu.
 * Prices approximate in-app entree + add-on pricing.
 */
const MENU = [
  { id: 'ENT-BOWL', name: 'Burrito Bowl', category: 'Entrees', price: 9.65 },
  { id: 'ENT-BURR', name: 'Burrito', category: 'Entrees', price: 9.65 },
  { id: 'ENT-TACO', name: 'Tacos (3)', category: 'Entrees', price: 9.65 },
  { id: 'ENT-SALAD', name: 'Salad', category: 'Entrees', price: 9.65 },
  { id: 'ENT-QUES', name: 'Quesadilla', category: 'Entrees', price: 11.20 },
  { id: 'ENT-KIDS', name: 'Kids Build Your Own', category: 'Entrees', price: 5.40 },
  { id: 'ADD-GUAC', name: 'Add Guacamole', category: 'Add-Ons', price: 2.75 },
  { id: 'ADD-QUESO', name: 'Add Queso Blanco', category: 'Add-Ons', price: 2.55 },
  { id: 'ADD-PROTEIN', name: 'Double Protein', category: 'Add-Ons', price: 4.55 },
  { id: 'SIDE-CHIPS', name: 'Chips & Guacamole', category: 'Sides', price: 4.60 },
  { id: 'SIDE-QUESO', name: 'Chips & Queso Blanco', category: 'Sides', price: 4.60 },
  { id: 'DRK-FTN', name: 'Fountain Drink', category: 'Drinks', price: 2.95 },
  { id: 'DRK-MEXCOKE', name: 'Mexican Coca-Cola', category: 'Drinks', price: 3.35 },
  { id: 'DRK-AGUA', name: 'Organic Agua Fresca', category: 'Drinks', price: 3.35 },
];

/**
 * Pickup restaurants available for "Order Ahead".
 */
const STORES = [
  { id: 'CMG-0420', name: 'Chipotle — Newport Beach', address: '1101 Newport Center Dr, Newport Beach, CA 92660', state: 'CA' },
  { id: 'CMG-1187', name: 'Chipotle — Denver LoDo', address: '1480 16th St Mall, Denver, CO 80202', state: 'CO' },
  { id: 'CMG-2043', name: 'Chipotle — Chicago Loop', address: '212 W Monroe St, Chicago, IL 60606', state: 'IL' },
  { id: 'CMG-3310', name: 'Chipotle — Austin Domain', address: '11700 Domain Blvd, Austin, TX 78758', state: 'TX' },
  { id: 'CMG-4521', name: 'Chipotle — NYC Union Square', address: '19 E 8th St, New York, NY 10003', state: 'NY' },
];

/**
 * Sales-tax profile per state, applied to the digital order subtotal.
 */
const STATE_TAX = {
  CA: { rate: 0.0725, label: 'CA state + local' },
  CO: { rate: 0.029, label: 'CO state' },
  IL: { rate: 0.1025, label: 'IL prepared food' },
  TX: { rate: 0.0825, label: 'TX state + local' },
  NY: { rate: 0.08875, label: 'NYC prepared food' },
};

const SERVICE_FEE_RATE = 0.05;

/**
 * Validate the digital order items and compute line-level subtotals.
 */
function validateOrderItems(items) {
  return items.map((item) => {
    const menuItem = MENU.find((m) => m.id === item.itemId);
    if (!menuItem) return null;
    const qty = item.qty || 1;
    return {
      itemId: menuItem.id,
      name: menuItem.name,
      qty,
      unitPrice: menuItem.price,
      lineTotal: Math.round(menuItem.price * qty * 100) / 100,
    };
  }).filter(Boolean);
}

/**
 * Resolve the pickup restaurant for the order.
 */
function resolveStore(storeId) {
  const store = STORES.find((s) => s.id === storeId);
  if (!store) return null;
  return {
    id: store.id,
    name: store.name,
    address: store.address,
    state: store.state,
  };
}

/**
 * Compute order pricing: subtotal, tax (by store location), digital
 * service fee, and grand total.
 */
function computeOrderPricing(validatedItems, store) {
  const subtotal = validatedItems.reduce((sum, li) => sum + li.lineTotal, 0);
  const tax = Math.round(subtotal * store.taxProfile.rate * 100) / 100;
  const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE * 100) / 100;
  const total = Math.round((subtotal + tax + serviceFee) * 100) / 100;

  return {
    subtotal: subtotal.toFixed(2),
    tax: tax.toFixed(2),
    taxLabel: store.taxProfile.label,
    serviceFee: serviceFee.toFixed(2),
    total: total.toFixed(2),
    itemCount: validatedItems.length,
  };
}

/**
 * Process a digital "Order Ahead" checkout.
 */
async function processOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Chipotle order-ahead checkout', {
    orderId,
    storeId: data.storeId,
    itemCount: data.items ? data.items.length : 0,
    service: 'chipotle-order-ahead',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const validatedItems = validateOrderItems(data.items || []);
    if (validatedItems.length === 0) {
      const err = new Error('Your bag is empty. Please add at least one item.');
      err.name = 'EmptyBagError';
      err.code = 'EMPTY_BAG';
      throw err;
    }

    const store = resolveStore(data.storeId);
    if (!store) {
      const err = new Error('Pickup restaurant not found. Please choose a location.');
      err.name = 'StoreNotFoundError';
      err.code = 'STORE_NOT_FOUND';
      throw err;
    }

    const pricing = computeOrderPricing(validatedItems, store);

    const duration = Date.now() - startTime;
    incrementMetric('chipotle_order.success', { route: '/api/chipotle/order', storeId: data.storeId });
    recordTiming('chipotle_order.latency', duration, { route: '/api/chipotle/order' });

    return {
      success: true,
      orderId,
      items: validatedItems,
      ...pricing,
      pickup: { storeId: store.id, storeName: store.name, address: store.address },
      pickupTime: data.pickupTime || 'ASAP (15–20 min)',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('chipotle_order.failure', { route: '/api/chipotle/order', errorClass: error.name });
    recordTiming('chipotle_order.latency', duration, { route: '/api/chipotle/order', error: 'true' });
    logger.error('Chipotle order-ahead checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      storeId: data.storeId,
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/chipotle/order',
        service: 'chipotle-order-ahead',
        storeId: data.storeId,
      },
      extra: { orderId, itemCount: data.items ? data.items.length : 0 },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/chipotle.js \u2014 computeOrderPricing',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'chipotle-order-ahead',
      verticalLabel: 'Chipotle Order Ahead',
      customer: 'chipotle',
      tags: [
        { key: 'route', value: '/api/chipotle/order' },
        { key: 'service', value: 'chipotle-order-ahead' },
        { key: 'storeId', value: data.storeId },
      ],
      extra: { orderId, storeId: data.storeId, itemCount: data.items ? data.items.length : 0 },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'chipotle-order-ahead@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from Chipotle order error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = { processOrder, MENU, STORES, STATE_TAX };
