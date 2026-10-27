const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/recalllookup/search';
const SERVICE = 'recall-search-api';

/**
 * Vehicle build records keyed by chassis number (frame division + frame number),
 * as loaded by the nightly build-record import.
 */
const VEHICLES = new Map([
  ['TKX230-0104518', { model: 'TKX230', typeDesignation: '6LA-TKX230', builtOn: '2026-09-18' }],
  ['TKX210-3021877', { model: 'TKX210', typeDesignation: '6AA-TKX210', builtOn: '2023-11-02' }],
  ['TKX210-3058412', { model: 'TKX210', typeDesignation: '6AA-TKX210', builtOn: '2024-06-21' }],
  ['TKY150-1007391', { model: 'TKY150', typeDesignation: '3BA-TKY150', builtOn: '2021-04-09' }],
]);

/**
 * Recall, improvement-measure and service-campaign coverage indexed by type designation.
 */
const CAMPAIGN_INDEX = {
  '6AA-TKX210': { campaigns: [] },
  '3BA-TKY150': { campaigns: [] },
  '6LA-TKX230 ': { campaigns: [] },
};

function lookupError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Look up a vehicle by chassis number and list the recalls, improvement measures and
 * service campaigns that apply to it, with their repair status.
 */
async function searchRecalls(searchData, options = {}) {
  const startTime = Date.now();
  const searchId = uuidv4();
  const frameDiv = String(searchData.frameDiv || '').trim().toUpperCase();
  const frameNo = String(searchData.frameNo || '').trim();

  logger.info('Searching recalls by chassis number', { searchId, frameDiv, frameNo, service: SERVICE, route: ROUTE });

  try {
    if (!/^[A-Z0-9]{2,6}$/.test(frameDiv) || !/^\d{1,7}$/.test(frameNo)) {
      throw lookupError('車台番号を半角英数字で正しく入力してください。', 'INVALID_CHASSIS');
    }
    const chassisNumber = `${frameDiv}-${frameNo}`;
    const vehicle = VEHICLES.get(chassisNumber);
    if (!vehicle) {
      throw lookupError('ご入力の車台番号に該当する車両が見つかりませんでした。', 'CHASSIS_NOT_FOUND');
    }
    const coverage = CAMPAIGN_INDEX[vehicle.typeDesignation];
    const campaigns = coverage.campaigns.map((c) => ({ ...c }));
    const duration = Date.now() - startTime;

    incrementMetric('recall.search.success', { route: ROUTE, service: SERVICE });
    recordTiming('recall.search.latency', duration, { route: ROUTE, service: SERVICE });

    return {
      success: true, searchId, chassisNumber, model: vehicle.model, builtOn: vehicle.builtOn, campaigns,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('recall.search.failure', { route: ROUTE, service: SERVICE, errorClass: error.name });
    recordTiming('recall.search.latency', duration, { route: ROUTE, service: SERVICE, error: 'true' });
    logger.error('Recall search failed', {
      searchId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, frameDiv, frameNo, service: SERVICE,
    });
    if (!['INVALID_CHASSIS', 'CHASSIS_NOT_FOUND'].includes(error.code)) {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { searchId, frameDiv, frameNo },
      });
    }
    throw error;
  }
}

module.exports = { searchRecalls, VEHICLES, CAMPAIGN_INDEX };
