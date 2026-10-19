const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/esnlookup/lookup';

/**
 * Engine build records keyed by engine serial number (ESN).
 */
const ENGINES = new Map([
  ['79464646', { model: 'X15', rating: '565 HP @ 1800 RPM', ecm: 'CM2350 X116B', builtOn: '2024-03-12', cpl: '4630' }],
  ['73283421', { model: 'ISX15', rating: '450 HP @ 1800 RPM', ecm: 'CM2350 X101', builtOn: '2016-09-28', cpl: '3710' }],
  ['74184057', { model: 'X15', rating: '500 HP @ 1800 RPM', ecm: 'CM2350 X114B', builtOn: '2019-05-06', cpl: '4214' }],
]);

/**
 * Service publications indexed by engine model and ECM platform.
 */
const SERVICE_LIBRARY = {
  'ISX15|CM2350 X101': {
    manuals: [
      { id: '4332675', title: 'Owners Manual ISX15 CM2350 X101' },
      { id: '4332702', title: 'Troubleshooting and Repair Manual ISX15 CM2350 X101' },
      { id: '4332653', title: 'Wiring Diagram ISX15 CM2350 X101' },
    ],
  },
  'X15|CM2350 X114B': {
    manuals: [
      { id: '5504478', title: 'Owners Manual X15 CM2350 X114B' },
      { id: '5504497', title: 'Troubleshooting and Repair Manual X15 CM2350 X114B' },
      { id: '5504513', title: 'Wiring Diagram X15 CM2350 X114B' },
    ],
  },
};

/**
 * Look up an engine by ESN and list the service manuals published for it.
 */
async function lookupEsn(lookupData, options = {}) {
  const startTime = Date.now();
  const lookupId = uuidv4();
  const esn = String(lookupData.esn || '').trim();

  logger.info('Looking up engine serial number', { lookupId, esn, service: 'esn-lookup-api', route: ROUTE });

  try {
    if (!/^\d{8}$/.test(esn)) {
      const error = new Error('ESN must be 8 digits');
      error.code = 'INVALID_ESN';
      throw error;
    }
    const engine = ENGINES.get(esn);
    if (!engine) {
      const error = new Error(`No engine found for ESN ${esn}`);
      error.code = 'ESN_NOT_FOUND';
      throw error;
    }
    const library = SERVICE_LIBRARY[`${engine.model}|${engine.ecm}`];
    const manuals = library.manuals.map((m) => ({ ...m, url: `/qsol/manuals/${m.id}` }));
    const duration = Date.now() - startTime;

    incrementMetric('esn.lookup.success', { route: ROUTE });
    recordTiming('esn.lookup.latency', duration, { route: ROUTE });

    return { success: true, lookupId, esn, engine: { ...engine }, manuals };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('esn.lookup.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('esn.lookup.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('ESN lookup failed', {
      lookupId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, esn,
    });
    if (!['INVALID_ESN', 'ESN_NOT_FOUND'].includes(error.code)) {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: 'esn-lookup-api', ...(options.synthetic ? { synthetic_probe: 'true' } : {}) },
        extra: { lookupId, esn },
      });
    }
    throw error;
  }
}

module.exports = { lookupEsn, ENGINES, SERVICE_LIBRARY };
