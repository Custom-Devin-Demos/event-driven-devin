const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/059b9215/inspection';
const SERVICE = 'inspection-report-api';

/**
 * Facilities under maintenance contract, keyed by facility id. `voltageClass`
 * selects the measurement spec a reading is judged against.
 */
const FACILITIES = {
  'FAC-2041': { name: '北関東物流センター 受変電設備', equipment: 'キュービクル式高圧受電設備（6.6kV）', voltageClass: 'hv', lastValue: 480 },
  'FAC-2187': { name: '湾岸データセンター 第2変電室', equipment: '特別高圧受変電設備（66kV）', voltageClass: 'ehv', lastValue: 1250 },
  'FAC-2302': { name: '相模川浄水場 動力盤', equipment: '低圧動力盤・自家発電設備', voltageClass: 'lv', lastValue: 32 },
  'FAC-2415': { name: '本社ビル 非常用発電設備', equipment: '非常用ディーゼル発電機（500kVA）', voltageClass: 'lv', lastValue: 28 },
};

/**
 * Inspection types offered on the submission form.
 */
const INSPECTION_TYPES = {
  monthly: { label: '月次点検', requiresOutage: false },
  annual: { label: '年次点検（停電）', requiresOutage: true },
  special: { label: '臨時点検', requiresOutage: false },
  precision: { label: '精密点検', requiresOutage: true },
};

/**
 * Insulation-resistance acceptance specs (MΩ) per voltage class. The report
 * generator judges each reading as 良 / 注意 / 要対策 against these.
 */
const MEASUREMENT_SPECS = {
  hv: { limits: { min: 5, caution: 10 }, unit: 'MΩ' },
  ehv: { limits: { min: 100, caution: 500 }, unit: 'MΩ' },
  lv: { limits: { min: 0.2, caution: 1 }, unit: 'MΩ' },
};

/**
 * Retrieve the measurement spec for a facility's voltage class.
 */
function getMeasurementSpec(facility) {
  return MEASUREMENT_SPECS[facility.voltageClass] || MEASUREMENT_SPECS.lv;
}

/**
 * Judge a reading against the spec: 良 above the caution band, 注意 within
 * it, 要対策 below the minimum.
 */
function judgeReading(spec, value) {
  if (value < spec.limit.min) return { grade: '要対策', remark: '規定値未満' };
  if (value < spec.limit.caution) return { grade: '注意', remark: '注意帯' };
  return { grade: '良', remark: '良好' };
}

/**
 * Submit an inspection result and generate its inspection report.
 */
async function submitInspection(data) {
  const startTime = Date.now();
  const submissionId = uuidv4();

  logger.info('Submitting inspection result', {
    submissionId,
    facilityId: data.facilityId,
    inspectionType: data.inspectionType,
    value: data.value,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 140));

    const facility = FACILITIES[data.facilityId] || FACILITIES['FAC-2041'];
    const type = INSPECTION_TYPES[data.inspectionType] || INSPECTION_TYPES.monthly;
    const spec = getMeasurementSpec(facility);
    const judgement = judgeReading(spec, data.value);

    const duration = Date.now() - startTime;

    incrementMetric('inspection.success', { route: ROUTE, inspectionType: data.inspectionType });
    recordTiming('inspection.latency', duration, { route: ROUTE });

    return {
      success: true,
      submissionId,
      reportId: `RPT-${submissionId.slice(0, 8).toUpperCase()}`,
      facilityId: data.facilityId,
      facilityName: facility.name,
      inspectionType: data.inspectionType,
      inspectionLabel: type.label,
      value: data.value,
      unit: spec.unit,
      previousValue: facility.lastValue,
      grade: judgement.grade,
      remark: judgement.remark,
      inspectedOn: data.inspectedOn,
      notes: data.notes,
      status: 'report-generated',
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inspection.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('inspection.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Inspection submission failed', {
      submissionId,
      facilityId: data.facilityId,
      inspectionType: data.inspectionType,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, inspectionType: data.inspectionType, alert_path: 'instant' },
      extra: { submissionId, facilityId: data.facilityId, value: data.value },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/059b9215.js — submitInspection',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Inspection Report',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alert_path', value: 'instant' },
      ],
      extra: { submissionId, facilityId: data.facilityId, inspectionType: data.inspectionType, value: data.value },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'inspection-report@3.1.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from inspection error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { submitInspection, FACILITIES, INSPECTION_TYPES };
