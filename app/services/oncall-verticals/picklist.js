const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/picklist/add';

/**
 * Genuine parts as returned by the parts master, keyed by part number.
 * `shipment` carries the parcel dimensions used to pick a freight class.
 */
const PARTS = new Map([
  ['3800984', { description: 'Water Pump', sellable: false, shipment: null }],
  ['4089650', { description: 'Water Pump', sellable: true, shipment: { weight: { value: 9.2, uom: 'lb' }, length: 11, width: 9, height: 8 } }],
  ['3955161', { description: 'Fuel Filter Head', sellable: true, shipment: { weight: { value: 1.4, uom: 'lb' }, length: 6, width: 5, height: 5 } }],
  ['4955254', { description: 'Exhaust Manifold Gasket', sellable: true, shipment: { weight: { value: 0.3, uom: 'lb' }, length: 10, width: 4, height: 1 } }],
]);

function freightClass(weight) {
  const pounds = weight.uom === 'kg' ? weight.value * 2.20462 : weight.value;
  if (pounds <= 1) return 'LETTER';
  if (pounds <= 20) return 'PARCEL';
  return 'LTL';
}

/**
 * Add a genuine part to the visitor's pick list.
 */
async function addToPickList(itemData, options = {}) {
  const startTime = Date.now();
  const pickListLineId = uuidv4();
  const { partNumber } = itemData;

  logger.info('Adding part to pick list', {
    pickListLineId, partNumber, quantity: itemData.quantity, service: 'picklist-api', route: ROUTE,
  });

  try {
    const part = PARTS.get(String(partNumber));
    if (!part) {
      const error = new Error(`Unknown part number: ${partNumber}`);
      error.code = 'PART_NOT_FOUND';
      throw error;
    }
    const quantity = Math.min(Math.max(parseInt(itemData.quantity, 10) || 1, 1), 99);
    const line = {
      partNumber: String(partNumber),
      description: part.description,
      quantity,
      freightClass: freightClass(part.shipment.weight),
    };
    const duration = Date.now() - startTime;

    incrementMetric('picklist.add.success', { route: ROUTE });
    recordTiming('picklist.add.latency', duration, { route: ROUTE });

    return { success: true, pickListLineId, ...line, addedAt: new Date().toISOString() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('picklist.add.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('picklist.add.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Add to pick list failed', {
      pickListLineId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, partNumber,
    });
    if (error.code !== 'PART_NOT_FOUND') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'picklist-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { pickListLineId, partNumber, quantity: itemData.quantity },
      });
    }
    throw error;
  }
}

module.exports = { addToPickList, PARTS };
