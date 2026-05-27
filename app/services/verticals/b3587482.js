const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Chick-fil-A catering menu items
 */
const CATERING_MENU = [
  { id: 'CFA-NUG-30', name: 'Chick-fil-A Nuggets (30 ct)', category: 'Entrees', price: 15.25, servings: 5, perTray: false },
  { id: 'CFA-NUG-64', name: 'Chick-fil-A Nuggets (64 ct)', category: 'Entrees', price: 29.00, servings: 10, perTray: true },
  { id: 'CFA-NUG-120', name: 'Chick-fil-A Nuggets (120 ct)', category: 'Entrees', price: 54.00, servings: 20, perTray: true },
  { id: 'CFA-CST-12', name: 'Chick-fil-A Chick-n-Strips Tray (12 ct)', category: 'Entrees', price: 24.50, servings: 6, perTray: true },
  { id: 'CFA-SWT-12', name: 'Chicken Sandwich Tray (12 ct)', category: 'Entrees', price: 54.00, servings: 12, perTray: true },
  { id: 'CFA-WRP-8', name: 'Cool Wrap Tray (8 ct)', category: 'Entrees', price: 57.00, servings: 8, perTray: true },
  { id: 'CFA-FRT-LG', name: 'Fruit Tray (Large)', category: 'Sides & Salads', price: 32.50, servings: 16, perTray: true },
  { id: 'CFA-GAR-LG', name: 'Garden Salad Tray (Large)', category: 'Sides & Salads', price: 28.00, servings: 12, perTray: true },
  { id: 'CFA-MAC-LG', name: 'Mac & Cheese Tray (Large)', category: 'Sides & Salads', price: 26.00, servings: 10, perTray: true },
  { id: 'CFA-BRO-1G', name: 'Gallon Freshly-Brewed Iced Tea', category: 'Beverages', price: 7.50, servings: 8, perTray: false },
  { id: 'CFA-LEM-1G', name: 'Gallon Chick-fil-A Lemonade', category: 'Beverages', price: 10.00, servings: 8, perTray: false },
  { id: 'CFA-COO-6', name: 'Chocolate Chunk Cookie (6-pack)', category: 'Desserts', price: 7.69, servings: 6, perTray: false },
  { id: 'CFA-BRW-6', name: 'Chocolate Fudge Brownie (6-pack)', category: 'Desserts', price: 8.29, servings: 6, perTray: false },
];

/**
 * Available Chick-fil-A catering locations
 */
const LOCATIONS = [
  { id: 'LOC-ATL-001', name: 'Chick-fil-A Midtown', address: '1275 Peachtree St NE, Atlanta, GA 30309', leadTime: 24 },
  { id: 'LOC-ATL-002', name: 'Chick-fil-A Buckhead', address: '3424 Peachtree Rd NE, Atlanta, GA 30326', leadTime: 24 },
  { id: 'LOC-DAL-001', name: 'Chick-fil-A Uptown', address: '2501 Cedar Springs Rd, Dallas, TX 75201', leadTime: 24 },
  { id: 'LOC-NYC-001', name: 'Chick-fil-A Fulton St', address: '144 Fulton St, New York, NY 10038', leadTime: 48 },
  { id: 'LOC-CHI-001', name: 'Chick-fil-A Michigan Ave', address: '30 E Chicago Ave, Chicago, IL 60611', leadTime: 24 },
];

/**
 * Validate the catering order items and compute line-level subtotals.
 */
function validateOrderItems(items) {
  const validated = items.map((item) => {
    const menuItem = CATERING_MENU.find((m) => m.id === item.itemId);
    if (!menuItem) return null;
    return {
      itemId: menuItem.id,
      name: menuItem.name,
      qty: item.qty,
      unitPrice: menuItem.price,
      lineTotal: menuItem.price * item.qty,
    };
  }).filter(Boolean);
  return validated;
}

/**
 * Resolve delivery details: location info, delivery date, and estimated headcount.
 */
function resolveDeliveryDetails(orderData) {
  const location = LOCATIONS.find((l) => l.id === orderData.locationId);
  if (!location) return null;

  return {
    pickup: {
      locationId: location.id,
      locationName: location.name,
      address: location.address,
    },
    headcount: orderData.headcount,
    dateRequested: orderData.deliveryDate,
  };
}

/**
 * Compute the order pricing from validated items and delivery info.
 * Returns subtotal, tax, service fee, and grand total.
 */
function computeOrderPricing(validatedItems, deliveryInfo) {
  const subtotal = validatedItems.reduce((sum, li) => sum + li.lineTotal, 0);
  const taxRate = 0.075;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  const serviceFee = deliveryInfo.delivery.type === 'delivery' ? 25.00 : 0;
  const total = Math.round((subtotal + tax + serviceFee) * 100) / 100;

  return {
    subtotal: subtotal.toFixed(2),
    tax: tax.toFixed(2),
    serviceFee: serviceFee.toFixed(2),
    total: total.toFixed(2),
    itemCount: validatedItems.length,
  };
}

/**
 * Process a catering order submission.
 */
async function processCateringOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing catering order', {
    orderId,
    locationId: data.locationId,
    headcount: data.headcount,
    itemCount: data.items?.length,
    service: 'b3587482-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const validatedItems = validateOrderItems(data.items || []);
    if (validatedItems.length === 0) {
      const err = new Error('No valid menu items in order. Please select at least one item.');
      err.name = 'EmptyOrderError';
      err.code = 'EMPTY_ORDER';
      throw err;
    }

    const deliveryInfo = resolveDeliveryDetails(data);
    if (!deliveryInfo) {
      const err = new Error('Location not found. Please select a valid pickup location.');
      err.name = 'LocationNotFoundError';
      err.code = 'LOCATION_NOT_FOUND';
      throw err;
    }

    const pricing = computeOrderPricing(validatedItems, deliveryInfo);

    const duration = Date.now() - startTime;

    incrementMetric('catering.order.success', {
      route: '/api/b3587482/order',
      locationId: data.locationId,
    });
    recordTiming('catering.order.latency', duration, {
      route: '/api/b3587482/order',
    });

    return {
      success: true,
      orderId,
      items: validatedItems,
      ...pricing,
      pickup: deliveryInfo.pickup,
      headcount: deliveryInfo.headcount,
      deliveryDate: deliveryInfo.dateRequested,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('catering.order.failure', {
      route: '/api/b3587482/order',
      errorClass: error.name,
    });
    recordTiming('catering.order.latency', duration, {
      route: '/api/b3587482/order',
      error: 'true',
    });

    logger.error('Catering order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      locationId: data.locationId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b3587482/order',
        service: 'b3587482-api',
        locationId: data.locationId,
      },
      extra: {
        orderId,
        headcount: data.headcount,
        itemCount: data.items?.length,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b3587482.js \u2014 processCateringOrder',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: 'b3587482-api',
      verticalLabel: 'Catering Order',
      customer: 'b3587482',
      tags: [
        { key: 'route', value: '/api/b3587482/order' },
        { key: 'service', value: 'b3587482-api' },
        { key: 'locationId', value: data.locationId },
      ],
      extra: { orderId, headcount: data.headcount, itemCount: data.items?.length },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'b3587482@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from catering order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCateringOrder, CATERING_MENU, LOCATIONS };
