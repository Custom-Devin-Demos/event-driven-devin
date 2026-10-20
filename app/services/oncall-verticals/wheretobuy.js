const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/wheretobuy/retailers';

/**
 * Product catalog records as imported from the PIM, keyed by SKU.
 * `productLine` decides which distributor channel sells the SKU.
 */
const CATALOG = new Map([
  ['J6060B', { name: '1/4 in. Drive Ratcheting Head Micrometer Torque Wrench With Quick Release Head Design', productLine: 'TQW-QRH' }],
  ['J6062C', { name: '1/4 in. Drive Ratchet Head C Series Micrometer Torque Wrench', productLine: 'TQW-MIC' }],
  ['J6062CXCERT', { name: '1/4 in. Drive Ratchet Head CXCERT Series Micrometer Torque Wrench', productLine: 'TQW-CERT' }],
  ['J6064C', { name: '3/8 in. Drive Ratchet Head C Series Micrometer Torque Wrench', productLine: 'TQW-MIC' }],
  ['J6064CXCERT', { name: '1/4 in. Drive Ratchet Head CXCERT Series Micrometer Torque Wrench', productLine: 'TQW-CERT' }],
  ['J6066C', { name: '3/8 in. Drive Ratchet Head C Series Micrometer Torque Wrench', productLine: 'TQW-MIC' }],
  ['J6066CXCERT', { name: '3/8 in. Drive Ratchet Head CXCERT Series Micrometer Torque Wrench', productLine: 'TQW-CERT' }],
  ['J6068C', { name: '1/2 in. Drive Ratchet Head C Series Micrometer Torque Wrench', productLine: 'TQW-MIC' }],
  ['J6072C', { name: '1/2 in. Drive Ratchet Head C Series Micrometer Torque Wrench', productLine: 'TQW-MIC' }],
  ['J6072CXCERT', { name: '1/2 in. Drive Ratchet Head CXCERT Series Micrometer Torque Wrench', productLine: 'TQW-CERT' }],
  ['J6004D', { name: '3/8 in. 8-40 ft-lb Direct Read Micrometer Torque Wrench', productLine: 'TQW-MIC' }],
  ['J6012FC', { name: '3/8 in. Drive Round Flex Head Micrometer Torque Wrench', productLine: 'TQW-MIC' }],
  ['J6202A', { name: '750 ft-lb Reaction Arm Torque Multiplier', productLine: 'TQM' }],
]);

const LINE_CHANNELS = {
  'TQW-MIC': 'IND-MRO',
  'TQW-CERT': 'IND-CAL',
  TQM: 'IND-MRO',
};

const CHANNEL_RETAILERS = {
  'IND-MRO': {
    retailers: [
      { name: 'Grainger', type: 'online' },
      { name: 'MSC Industrial Supply', type: 'online' },
      { name: 'Fastenal', type: 'online' },
      { name: 'Zoro', type: 'online' },
    ],
  },
  'IND-CAL': {
    retailers: [
      { name: 'Grainger', type: 'online' },
      { name: 'MSC Industrial Supply', type: 'online' },
    ],
  },
};

/**
 * List the distributors that stock a SKU for the Where to Buy panel.
 */
async function findRetailers(lookup, options = {}) {
  const startTime = Date.now();
  const lookupId = uuidv4();
  const sku = String(lookup.sku || '').toUpperCase();

  logger.info('Where to Buy lookup', {
    lookupId, sku, service: 'where-to-buy-api', route: ROUTE,
  });

  try {
    const product = CATALOG.get(sku);
    if (!product) {
      const error = new Error(`Unknown SKU: ${sku}`);
      error.code = 'SKU_NOT_FOUND';
      throw error;
    }
    const channel = LINE_CHANNELS[product.productLine];
    const retailers = CHANNEL_RETAILERS[channel].retailers.map((r) => ({ ...r }));
    const duration = Date.now() - startTime;

    incrementMetric('wheretobuy.lookup.success', { route: ROUTE });
    recordTiming('wheretobuy.lookup.latency', duration, { route: ROUTE });

    return {
      success: true, lookupId, sku, name: product.name, channel, retailers,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('wheretobuy.lookup.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('wheretobuy.lookup.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Where to Buy lookup failed', {
      lookupId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, sku,
    });
    if (error.code !== 'SKU_NOT_FOUND') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'where-to-buy-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { lookupId, sku },
      });
    }
    throw error;
  }
}

module.exports = { findRetailers, CATALOG };
