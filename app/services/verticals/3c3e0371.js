const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const MARKET_DIRECTORY = {
  75: { code: 'DAL', dcId: 'dc-214', label: 'Dallas Metro' },
  10: { code: 'NYC', dcId: 'dc-646', label: 'New York Metro' },
  60: { code: 'CHI', dcId: 'dc-312', label: 'Chicagoland' },
  90: { code: 'LAX', dcId: 'dc-213', label: 'Greater Los Angeles' },
};

const STORE_CATALOG = {
  DAL: [
    { storeId: '35162', address: '1919 McKinney Ave', slots: 14, fuel: true },
    { storeId: '38921', address: '2707 Ross Ave', slots: 9, fuel: false },
    { storeId: '33410', address: '400 S Ervay St', slots: 11, fuel: true },
  ],
  NYC: [
    { storeId: '11208', address: '345 W 42nd St', slots: 6, fuel: false },
    { storeId: '11342', address: '711 8th Ave', slots: 8, fuel: false },
  ],
  CHI: [
    { storeId: '22815', address: '20 E Jackson Blvd', slots: 12, fuel: true },
  ],
  LAX: [
    { storeId: '41007', address: '600 S Spring St', slots: 10, fuel: true },
  ],
};

function resolveMarket(zip) {
  const prefix = parseInt(String(zip).slice(0, 2), 10);
  const market = MARKET_DIRECTORY[prefix] || MARKET_DIRECTORY[75];
  return { ...market, zip: String(zip) };
}

function buildSlotIndex(market) {
  const stores = STORE_CATALOG[market.code] || [];
  const byStore = new Map();
  for (const store of stores) {
    byStore.set(store.storeId, {
      storeId: store.storeId,
      address: store.address,
      slots: store.slots,
      fuel: store.fuel,
    });
  }
  return {
    marketCode: market.code,
    dcId: market.dcId,
    byStore,
    stores: Array.from(byStore.values()),
  };
}

function rankStores(index, fulfillment) {
  const eligible = (index.stores || []).filter(
    (store) => fulfillment !== 'fuel' || store.fuel
  );
  return eligible.sort((a, b) => b.slots - a.slots);
}

function formatStoreResults(ranked, market) {
  return ranked.slice(0, 3).map((store, position) => ({
    rank: position + 1,
    storeId: store.storeId,
    address: store.address,
    market: market.label,
    pickupSlots: store.slots,
  }));
}

async function processStoreSearch(data) {
  const requestId = uuidv4();
  const startTime = Date.now();

  logger.info('Store search request received', {
    requestId,
    zip: data.zip,
    fulfillment: data.fulfillment,
  });

  incrementMetric('vertical_3c3e0371.store_search.requested', 1, [
    `fulfillment:${data.fulfillment}`,
  ]);

  try {
    const market = resolveMarket(data.zip);
    const index = buildSlotIndex(market);
    const ranked = rankStores(index, data.fulfillment);
    const results = formatStoreResults(ranked, market);

    recordTiming('vertical_3c3e0371.store_search.duration', Date.now() - startTime);
    incrementMetric('vertical_3c3e0371.store_search.succeeded', 1);

    logger.info('Store search completed', { requestId, count: results.length });

    return { success: true, requestId, market: market.label, stores: results };
  } catch (error) {
    incrementMetric('vertical_3c3e0371.store_search.failed', 1, [
      `error:${error.name}`,
    ]);

    logger.error('Store search failed', {
      requestId,
      error: error.message,
      errorType: error.name,
      zip: data.zip,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/3c3e0371/store-search',
        service: 'customer-3c3e0371-demo',
        fulfillment: data.fulfillment,
      },
      extra: { requestId, zip: data.zip, fulfillment: data.fulfillment },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/3c3e0371.js — rankStores',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-3c3e0371-demo',
      verticalLabel: 'Store Search Request',
      customer: '3c3e0371',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/3c3e0371/store-search' },
        { key: 'service', value: 'customer-3c3e0371-demo' },
        { key: 'fulfillment', value: data.fulfillment },
      ],
      extra: { requestId, zip: data.zip, fulfillment: data.fulfillment },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-3c3e0371-demo@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for store search error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processStoreSearch,
  resolveMarket,
  buildSlotIndex,
  rankStores,
  formatStoreResults,
  MARKET_DIRECTORY,
  STORE_CATALOG,
};
