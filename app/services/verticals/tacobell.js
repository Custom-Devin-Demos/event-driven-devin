const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Taco Bell "Order Ahead" digital menu.
 * Prices approximate current app menu pricing.
 */
const MENU = [
  { id: 'TACO-CRUNCHY', name: 'Crunchy Taco', category: 'Tacos', price: 1.79 },
  { id: 'TACO-SOFT', name: 'Soft Taco', category: 'Tacos', price: 1.79 },
  { id: 'TACO-DORITOS', name: 'Doritos Locos Taco', category: 'Tacos', price: 2.49 },
  { id: 'BURRITO-5LAYER', name: 'Beefy 5-Layer Burrito', category: 'Burritos', price: 3.69 },
  { id: 'BURRITO-BEAN', name: 'Bean Burrito', category: 'Burritos', price: 1.99 },
  { id: 'SPEC-CRUNCHWRAP', name: 'Crunchwrap Supreme', category: 'Specialties', price: 5.49 },
  { id: 'SPEC-QUESADILLA', name: 'Quesadilla Chicken', category: 'Specialties', price: 5.79 },
  { id: 'SPEC-PIZZA', name: 'Mexican Pizza', category: 'Specialties', price: 5.99 },
  { id: 'SIDE-FRIES', name: 'Nacho Fries', category: 'Sides & Sweets', price: 2.69 },
  { id: 'SIDE-TWISTS', name: 'Cinnamon Twists', category: 'Sides & Sweets', price: 1.29 },
  { id: 'DRINK-BAJA', name: 'Baja Blast', category: 'Drinks', price: 2.79 },
  { id: 'DRINK-FOUNTAIN', name: 'Regular Fountain Drink', category: 'Drinks', price: 2.49 },
  { id: 'SAUCE-AVOCADO', name: 'Avocado Verde Salsa Sauce', category: 'Sauces', price: 0.30 },
  { id: 'SAUCE-MILD', name: 'Mild Sauce', category: 'Sauces', price: 0.00 },
];

const STORES = [
  { id: 'TB-0420', name: 'Taco Bell — Irvine Spectrum', address: '91 Fortune Dr, Irvine, CA 92618', state: 'CA' },
  { id: 'TB-1187', name: 'Taco Bell — Denver LoDo', address: '1620 Market St, Denver, CO 80202', state: 'CO' },
  { id: 'TB-2043', name: 'Taco Bell — Chicago Loop', address: '111 W Washington St, Chicago, IL 60602', state: 'IL' },
  { id: 'TB-3310', name: 'Taco Bell — Austin Riverside', address: '1701 E Riverside Dr, Austin, TX 78741', state: 'TX' },
  { id: 'TB-4521', name: 'Taco Bell — Queens Boulevard', address: '89-01 Queens Blvd, Elmhurst, NY 11373', state: 'NY' },
];

const STATE_TAX = {
  CA: { rate: 0.0725, label: 'CA state + local' },
  CO: { rate: 0.029, label: 'CO state' },
  IL: { rate: 0.1025, label: 'IL prepared food' },
  TX: { rate: 0.0825, label: 'TX state + local' },
  NY: { rate: 0.08875, label: 'NYC prepared food' },
};

const SERVICE_FEE_RATE = 0.05;

const REWARDS_PROGRAMS = {
  hot_tier: { pointsMultiplier: 1 },
};

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

function resolveStore(storeId) {
  const store = STORES.find((s) => s.id === storeId);
  if (!store) return null;
  return {
    id: store.id,
    name: store.name,
    address: store.address,
    state: store.state,
    taxProfile: STATE_TAX[store.state],
  };
}

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

function normalizeRewardsTier(tier) {
  return { hot: 'hot_tier', fire: 'fire_tier' }[tier];
}

function applyRewards(pricing, tier) {
  const program = REWARDS_PROGRAMS[normalizeRewardsTier(tier)];
  const rewardsPoints = Math.floor(Number(pricing.subtotal) * program.pointsMultiplier);
  return { ...pricing, rewardsTier: tier, rewardsPoints };
}

async function processOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Taco Bell order-ahead checkout', {
    orderId,
    storeId: data.storeId,
    itemCount: data.items ? data.items.length : 0,
    service: 'tacobell-order-ahead',
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
    const rewardsPricing = applyRewards(pricing, data.rewardsTier);

    const duration = Date.now() - startTime;
    incrementMetric('tacobell_order.success', { route: '/api/tacobell/order', storeId: data.storeId });
    recordTiming('tacobell_order.latency', duration, { route: '/api/tacobell/order' });

    return {
      success: true,
      orderId,
      items: validatedItems,
      ...rewardsPricing,
      pickup: { storeId: store.id, storeName: store.name, address: store.address },
      pickupTime: data.pickupTime || 'ASAP (15–20 min)',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('tacobell_order.failure', { route: '/api/tacobell/order', errorClass: error.name });
    recordTiming('tacobell_order.latency', duration, { route: '/api/tacobell/order', error: 'true' });
    logger.error('Taco Bell order-ahead checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      storeId: data.storeId,
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/tacobell/order',
        service: 'tacobell-order-ahead',
        storeId: data.storeId,
      },
      extra: { orderId, itemCount: data.items ? data.items.length : 0 },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/tacobell.js — applyRewards',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'tacobell-order-ahead',
      verticalLabel: 'Taco Bell Order Ahead',
      customer: 'tacobell',
      tags: [
        { key: 'route', value: '/api/tacobell/order' },
        { key: 'service', value: 'tacobell-order-ahead' },
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
      release: 'tacobell-order-ahead@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from Taco Bell order error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = { processOrder, MENU, STORES, STATE_TAX };
