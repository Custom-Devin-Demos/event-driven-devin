const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { buildFulfillmentPlan } = require('./d4990e18-fulfillment');

const RESTAURANTS = [
  {
    id: 'RST-1048',
    name: 'Juniper Table',
    cuisine: 'New American',
    rating: 4.8,
    deliveryTimeMinutes: '25–35',
    deliveryFee: 3.49,
    neighborhood: 'SoMa',
  },
  {
    id: 'RST-2271',
    name: 'Golden Wok Kitchen',
    cuisine: 'Chinese',
    rating: 4.7,
    deliveryTimeMinutes: '20–30',
    deliveryFee: 2.49,
    neighborhood: 'Chinatown',
  },
  {
    id: 'RST-3356',
    name: 'Harbor Pizza Co.',
    cuisine: 'Pizza',
    rating: 4.6,
    deliveryTimeMinutes: '30–40',
    deliveryFee: 1.99,
    neighborhood: 'Embarcadero',
  },
];

const MENU_ITEMS = [
  {
    id: 'ITEM-701',
    restaurantId: 'RST-1048',
    name: 'Crispy Chicken Grain Bowl',
    priceCents: 1895,
  },
  {
    id: 'ITEM-702',
    restaurantId: 'RST-1048',
    name: 'Charred Broccolini',
    priceCents: 1095,
  },
  {
    id: 'ITEM-801',
    restaurantId: 'RST-2271',
    name: 'Ginger Scallion Noodles',
    priceCents: 1595,
  },
  {
    id: 'ITEM-901',
    restaurantId: 'RST-3356',
    name: 'Market Street Margherita',
    priceCents: 2195,
  },
];

function findNearbyRestaurants(address) {
  const query = String(address || '').trim();
  return RESTAURANTS.map((restaurant, index) => ({
    ...restaurant,
    distanceMiles: Number((0.7 + index * 0.6 + query.length * 0.002).toFixed(1)),
  }));
}

function buildSuggestedBasket(restaurant) {
  const items = MENU_ITEMS.filter((item) => item.restaurantId === restaurant.id).slice(0, 2);
  return {
    restaurantId: restaurant.id,
    items,
    subtotalCents: items.reduce((total, item) => total + item.priceCents, 0),
  };
}

function calculateSearchQuote(basket, fulfillmentPlan) {
  const serviceFeeCents = fulfillmentPlan.fees.service.cents;
  const deliveryFeeCents = fulfillmentPlan.fees.delivery.cents;

  return {
    subtotalCents: basket.subtotalCents,
    serviceFeeCents,
    deliveryFeeCents,
    totalCents: basket.subtotalCents + serviceFeeCents + deliveryFeeCents,
  };
}

function formatSearchResult(requestId, restaurants, basket, quote, fulfillmentPlan) {
  return {
    success: true,
    requestId,
    restaurants,
    suggestedOrder: {
      restaurantId: basket.restaurantId,
      items: basket.items,
      subtotal: (quote.subtotalCents / 100).toFixed(2),
      fees: ((quote.serviceFeeCents + quote.deliveryFeeCents) / 100).toFixed(2),
      total: (quote.totalCents / 100).toFixed(2),
    },
    deliveryEstimate: {
      earliestMinutes: fulfillmentPlan.delivery.eta.earliestMinutes,
      latestMinutes: fulfillmentPlan.delivery.eta.latestMinutes,
    },
    searchedAt: new Date().toISOString(),
  };
}

async function processSearch(data) {
  const startTime = Date.now();
  const requestId = data.requestId || uuidv4();
  const address = String(data.address || '1455 Market Street, San Francisco').trim();
  const deliveryWindow = data.deliveryWindow || 'asap';

  logger.info('Searching nearby delivery options', {
    requestId,
    address,
    deliveryWindow,
    service: 'd4990e18-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const restaurants = findNearbyRestaurants(address);
    const basket = buildSuggestedBasket(restaurants[0]);
    const fulfillmentPlan = buildFulfillmentPlan(deliveryWindow, restaurants[0]);
    const quote = calculateSearchQuote(basket, fulfillmentPlan);
    const response = formatSearchResult(requestId, restaurants, basket, quote, fulfillmentPlan);
    const duration = Date.now() - startTime;

    incrementMetric('delivery_search.success', {
      route: '/api/d4990e18/search',
      deliveryWindow,
    });
    recordTiming('delivery_search.latency', duration, {
      route: '/api/d4990e18/search',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('delivery_search.failure', {
      route: '/api/d4990e18/search',
      errorClass: error.name,
      deliveryWindow,
    });
    recordTiming('delivery_search.latency', duration, {
      route: '/api/d4990e18/search',
      error: 'true',
    });

    logger.error('Delivery search failed', {
      requestId,
      address,
      deliveryWindow,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'd4990e18-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/d4990e18/search',
        service: 'd4990e18-api',
        deliveryWindow,
      },
      extra: {
        requestId,
        address,
        restaurantId: RESTAURANTS[0].id,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/d4990e18.js — processSearch',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'd4990e18-api',
      verticalLabel: 'Food Delivery Search',
      tags: [
        { key: 'route', value: '/api/d4990e18/search' },
        { key: 'service', value: 'd4990e18-api' },
        { key: 'deliveryWindow', value: deliveryWindow },
      ],
      extra: {
        requestId,
        address,
        restaurantId: RESTAURANTS[0].id,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'd4990e18@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from delivery search error', {
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = { processSearch, RESTAURANTS, MENU_ITEMS };
