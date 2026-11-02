const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/afd8d03a/ingest';
const SERVICE = 'afd8d03a-lab-pipeline';
const STUDY = 'MDT-DM-301 — Pivotal study, adults with type 2 diabetes';

/** Central-lab batches waiting at each trial site — fictional, de-identified demo data. */
const SITE_BATCHES = {
  'SITE-101': {
    site: 'Boston Clinical Unit', country: 'US',
    results: [
      { subject: 'S101-004', analyte: 'glucose', value: 142, unit: 'mg/dL' },
      { subject: 'S101-007', analyte: 'hba1c', value: 7.4, unit: '%' },
      { subject: 'S101-011', analyte: 'creatinine', value: 0.92, unit: 'mg/dL' },
    ],
  },
  'SITE-104': {
    site: 'Toronto Research Centre', country: 'CA',
    results: [
      { subject: 'S104-002', analyte: 'glucose', value: 7.9, unit: 'mmol/L' },
      { subject: 'S104-005', analyte: 'hba1c', value: 6.8, unit: '%' },
      { subject: 'S104-009', analyte: 'creatinine', value: 0.88, unit: 'mg/dL' },
    ],
  },
};

/** Conversions into the study's standard unit for each analyte. */
const UNIT_CONVERSIONS = {
  glucose: { standard: 'mg/dL', 'mg/dL': { factor: 1 } },
  hba1c: { standard: '%', '%': { factor: 1 } },
  creatinine: { standard: 'mg/dL', 'mg/dL': { factor: 1 }, 'umol/L': { factor: 1 / 88.4 } },
};

const REFERENCE_RANGES = { glucose: [70, 180], hba1c: [4, 9], creatinine: [0.5, 1.3] };

function normalize(result) {
  const conv = UNIT_CONVERSIONS[result.analyte];
  const value = Math.round(result.value * conv[result.unit].factor * 100) / 100;
  const [lo, hi] = REFERENCE_RANGES[result.analyte];
  return { ...result, value, unit: conv.standard, sourceUnit: result.unit, flag: value < lo || value > hi ? 'out-of-range' : 'ok' };
}

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

async function ingestBatch(data) {
  const startTime = Date.now();
  const batchId = `LAB-${uuidv4().slice(0, 8).toUpperCase()}`;
  logger.info('Ingesting central-lab batch', { batchId, siteId: data.siteId, service: SERVICE });

  const batch = SITE_BATCHES[data.siteId];
  if (!batch) throw new ValidationError('Unknown trial site');

  try {
    const normalized = batch.results.map(normalize);
    incrementMetric('lab_pipeline.batch.success', { route: ROUTE, site: data.siteId });
    incrementMetric('lab_pipeline.records', { route: ROUTE, site: data.siteId, count: String(normalized.length) });
    recordTiming('lab_pipeline.latency', Date.now() - startTime, { route: ROUTE });
    return {
      success: true, batchId, study: STUDY, siteId: data.siteId, site: batch.site,
      records: normalized, outOfRange: normalized.filter((r) => r.flag !== 'ok').length,
      loadedTo: 'study-warehouse.lab_results', ingestedAt: new Date().toISOString(),
    };
  } catch (error) {
    incrementMetric('lab_pipeline.batch.failure', { route: ROUTE, errorClass: error.name, site: data.siteId });
    recordTiming('lab_pipeline.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('Lab batch ingest failed', { batchId, error: error.message, errorClass: error.name, siteId: data.siteId });
    Sentry.captureException(error, { tags: { route: ROUTE, service: SERVICE, site: data.siteId }, extra: { batchId } });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/afd8d03a.js — ingestBatch',
      errorType: error.name || 'Error', errorValue: error.message,
      devinUserId: data.devinUserId, devinEmail: data.devinEmail, devinOrgId: data.devinOrgId, devinName: data.devinName,
      service: SERVICE, verticalLabel: 'Medtronic Clinical Lab Data Pipeline (Life Sciences)', customer: 'afd8d03a',
      tags: [{ key: 'route', value: ROUTE }, { key: 'service', value: SERVICE }, { key: 'site', value: String(data.siteId) }],
      extra: { batchId, siteId: data.siteId, study: STUDY },
      level: 'error', platform: 'node', firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || 'afd8d03a@1.0.0',
      environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    }).catch((err) => logger.error('Failed to trigger Devin session from lab pipeline error', { error: err.message }));
    throw error;
  }
}

module.exports = { ingestBatch, normalize, SITE_BATCHES, UNIT_CONVERSIONS, STUDY, ValidationError };
