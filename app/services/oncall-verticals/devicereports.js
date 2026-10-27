const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const REPORTS_ROUTE = '/api/oncall/devicereports/reports';
const SERVICE = 'carelink-reports-api';

const REPORT_DEADLINE_MS = 8000;
const SENSOR_HISTORY_HOST = 'sensor-history.carelink-data.internal';
const SENSOR_DAY_FETCH_LATENCY_MS = [560, 640];
const SENSOR_DELTA_FETCH_LATENCY_MS = [90, 140];
const READINGS_PER_DAY = 288;
const REPORT_PERIODS = [7, 14, 30, 90];
const UPLOAD_TYPES = ['full', 'incremental'];

const DEMO_PATIENT = {
  id: 'PT-20417',
  devices: { pump: { model: '780G', serial: 'NG4417' }, sensor: { model: 'Simplera Sync' } },
  lastCloudSyncDaysAgo: 3,
};

// Fictional summary per review period (time-in-range bands sum to 100).
const REPORT_SUMMARIES = {
  7: { timeInRange: [0, 2, 78, 16, 4], avgGlucoseMgDl: 142, gmiPct: 6.7, smartGuardPct: 95, sensorWearPct: 98 },
  14: { timeInRange: [1, 3, 74, 17, 5], avgGlucoseMgDl: 148, gmiPct: 6.8, smartGuardPct: 93, sensorWearPct: 96 },
  30: { timeInRange: [1, 3, 72, 18, 6], avgGlucoseMgDl: 151, gmiPct: 6.9, smartGuardPct: 92, sensorWearPct: 95 },
  90: { timeInRange: [1, 4, 70, 19, 6], avgGlucoseMgDl: 154, gmiPct: 7.0, smartGuardPct: 90, sensorWearPct: 94 },
};

const delay = ([minMs, maxMs]) => new Promise((resolve) => {
  setTimeout(resolve, minMs + Math.random() * (maxMs - minMs));
});

function invalidReport(message) {
  const error = new Error(message);
  error.code = 'INVALID_REPORT_REQUEST';
  return error;
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Report generation exceeded ${ms}ms`);
      error.code = 'REPORT_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function validateReportRequest(data = {}) {
  if (data.patientId !== DEMO_PATIENT.id) throw invalidReport('Select a patient.');
  if (!UPLOAD_TYPES.includes(data.uploadType)) throw invalidReport('Select an upload type.');
  const periodDays = Number(data.periodDays);
  if (!REPORT_PERIODS.includes(periodDays)) throw invalidReport('Choose a report period.');
  return { patientId: data.patientId, uploadType: data.uploadType, periodDays };
}

async function fetchSensorDay(patientId, dayOffset) {
  await delay(SENSOR_DAY_FETCH_LATENCY_MS);
  return { dayOffset, readings: READINGS_PER_DAY };
}

async function fetchSensorDelta(patientId, sinceDays) {
  await delay(SENSOR_DELTA_FETCH_LATENCY_MS);
  return { sinceDays, readings: READINGS_PER_DAY * sinceDays };
}

async function loadSensorHistory({ patientId, uploadType, periodDays }, reportId, deadlineAt) {
  if (uploadType === 'incremental') {
    const startedAt = Date.now();
    const delta = await withDeadline(
      fetchSensorDelta(patientId, DEMO_PATIENT.lastCloudSyncDaysAgo),
      Math.max(0, deadlineAt - startedAt),
    );
    logger.info('Sensor history fetch', {
      reportId, uploadType, host: SENSOR_HISTORY_HOST, readings: delta.readings,
      durationMs: Date.now() - startedAt, service: SERVICE, route: REPORTS_ROUTE,
    });
    return delta.readings;
  }

  let readings = 0;
  for (let dayOffset = 0; dayOffset < periodDays; dayOffset += 1) {
    const startedAt = Date.now();
    try {
      const day = await withDeadline(fetchSensorDay(patientId, dayOffset), Math.max(0, deadlineAt - startedAt));
      readings += day.readings;
      logger.info('Sensor history fetch', {
        reportId, uploadType, dayOffset, host: SENSOR_HISTORY_HOST, readings: day.readings,
        durationMs: Date.now() - startedAt, service: SERVICE, route: REPORTS_ROUTE,
      });
    } catch (error) {
      logger.info('Sensor history fetch', {
        reportId, uploadType, dayOffset, host: SENSOR_HISTORY_HOST,
        durationMs: Date.now() - startedAt,
        fetchStatus: error.code === 'REPORT_TIMEOUT' ? 'timed_out' : 'failed',
        service: SERVICE, route: REPORTS_ROUTE,
      });
      throw error;
    }
  }
  return readings;
}

async function generateReport(data = {}) {
  const startedAt = Date.now();
  const request = validateReportRequest(data);
  const reportId = `RPT-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const tags = { route: REPORTS_ROUTE, service: SERVICE, uploadType: request.uploadType };

  try {
    const readingsProcessed = await loadSensorHistory(request, reportId, startedAt + REPORT_DEADLINE_MS);
    const durationMs = Date.now() - startedAt;
    incrementMetric('devicereports.report.generate.success', tags);
    recordTiming('devicereports.report.generate.latency', durationMs, tags);
    return {
      success: true,
      report: {
        id: reportId,
        type: 'therapy-management-dashboard',
        patientId: request.patientId,
        uploadType: request.uploadType,
        periodDays: request.periodDays,
        readingsProcessed,
        summary: { ...REPORT_SUMMARIES[request.periodDays] },
      },
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    incrementMetric('devicereports.report.generate.failure', { ...tags, errorCode: error.code || error.name });
    recordTiming('devicereports.report.generate.latency', durationMs, { ...tags, error: 'true' });
    logger.error('Report generation failed', {
      reportId, error: error.message, code: error.code, durationMs,
      uploadType: request.uploadType, periodDays: request.periodDays,
      service: SERVICE, route: REPORTS_ROUTE,
    });
    Sentry.captureException(error, {
      tags: { route: REPORTS_ROUTE, service: SERVICE },
      extra: { reportId, uploadType: request.uploadType, periodDays: request.periodDays },
    });
    throw error;
  }
}

module.exports = {
  generateReport,
  validateReportRequest,
  loadSensorHistory,
  DEMO_PATIENT,
  REPORT_DEADLINE_MS,
  SENSOR_DAY_FETCH_LATENCY_MS,
  REPORT_PERIODS,
};
