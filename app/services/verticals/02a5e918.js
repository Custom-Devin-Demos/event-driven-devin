const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { declareDatadogIncident } = require('../datadog-incidents');

const SERVICE = 'customer-02a5e918-smarttime';
const ROUTE = '/api/02a5e918/timecards/send-to-payroll';

const PRODUCTION = {
  id: 'PRJ-24817',
  title: 'Silver Lake',
  season: 'Season 2',
  company: 'Juniper Hill Productions, LLC',
  weekEnding: '2026-10-24',
  payrollBatchId: 'TB-2026-10-24-01',
  payDate: '2026-10-30',
  payrollCompany: 'EP Payroll',
};

const TIMECARDS = [
  { id: 'TC-91841', crewName: 'Maya Torres', occupation: 'Key Grip', department: 'Grip', union: 'IATSE-80', hours: 58.5, rate: 58.42, status: 'Approved', accountCode: '2510-01' },
  { id: 'TC-91842', crewName: 'Dev Patel', occupation: 'Best Boy Electric', department: 'Electric', union: 'IATSE-728', hours: 56.0, rate: 55.14, status: 'Approved', accountCode: '2610-01' },
  { id: 'TC-91843', crewName: 'Lena Brooks', occupation: 'Set Decorator', department: 'Set Dressing', union: 'IATSE-44', hours: 52.0, rate: 54.38, status: 'Approved', accountCode: '2310-02' },
  { id: 'TC-91844', crewName: 'Andre Wallace', occupation: 'Driver Captain', department: 'Transportation', union: 'TEAMSTERS-399', hours: 61.0, rate: 49.86, status: 'Approved', accountCode: '3410-01' },
  { id: 'TC-91845', crewName: 'Noah Kim', occupation: '1st Assistant Camera', department: 'Camera', union: 'IATSE-600', hours: 59.5, rate: 61.27, status: 'Approved', accountCode: '2210-03', newHire: true },
  { id: 'TC-91846', crewName: 'Grace Liu', occupation: 'Production Coordinator', department: 'Production', union: 'NON-UNION', hours: 50.0, rate: 38.0, status: 'Approved', accountCode: '1410-01' },
];

const UNION_FRINGE_RULES = {
  'IATSE-80': { label: 'IATSE Local 80', pensionRate: 0.075, healthPerHour: 13.88, vacationHolidayRate: 0.0719 },
  'IATSE-728': { label: 'IATSE Local 728', pensionRate: 0.075, healthPerHour: 13.88, vacationHolidayRate: 0.0719 },
  'IATSE-44': { label: 'IATSE Local 44', pensionRate: 0.075, healthPerHour: 13.88, vacationHolidayRate: 0.0719 },
  'TEAMSTERS-399': { label: 'Teamsters Local 399', pensionRate: 0.082, healthPerHour: 14.21, vacationHolidayRate: 0.0719 },
  'ICG-600': { label: 'IATSE Local 600 (ICG)', pensionRate: 0.075, healthPerHour: 13.88, vacationHolidayRate: 0.0719 },
  'NON-UNION': { label: 'Non-union', pensionRate: 0, healthPerHour: 0, vacationHolidayRate: 0 },
};

const round = (value) => Math.round(value * 100) / 100;

function grossFor(timecard) {
  const straight = Math.min(timecard.hours, 40);
  const overtime = Math.max(timecard.hours - 40, 0);
  return round(straight * timecard.rate + overtime * timecard.rate * 1.5);
}

function resolveFringeRule(timecard) {
  return UNION_FRINGE_RULES[timecard.union];
}

function computeTimecardCost(timecard) {
  const rule = resolveFringeRule(timecard);
  const gross = grossFor(timecard);
  const fringe = round(gross * rule.pensionRate + timecard.hours * rule.healthPerHour + gross * rule.vacationHolidayRate);
  return { gross, fringe, totalLaborCost: round(gross + fringe), unionLabel: rule.label };
}

function getTimecardBatch() {
  return TIMECARDS.map((timecard) => {
    const rule = resolveFringeRule(timecard);
    return {
      ...timecard,
      unionLabel: rule ? rule.label : 'IATSE Local 600',
      gross: grossFor(timecard),
    };
  });
}

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'Production accountants cannot send the approved Silver Lake crew timecard batch to EP Payroll from SmartTime.',
  '- Service: `app/services/verticals/02a5e918.js`',
  '- Route: `app/routes/verticals/02a5e918.js`',
  '- Page: `app/public/verticals/02a5e918.html` (served at `/entertainment-partners`)',
  '',
  'Use Sentry and Datadog through MCP to confirm the failing union and request pattern before changing code.',
  'Fix the root cause in the union fringe rule lookup, keep the existing union rates unchanged, add regression coverage in `tests/ep-smarttime-payroll-batch.test.js`, and prove the full batch sends successfully.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

async function sendTimecardsToPayroll(data) {
  const startTime = Date.now();
  if (data.batchId !== PRODUCTION.payrollBatchId) {
    throw validationError(`Unknown timecard batch: ${data.batchId || '(none)'}`, 'UNKNOWN_TIMECARD_BATCH');
  }

  let timecardIds;
  if (data.timecardIds === undefined) {
    timecardIds = TIMECARDS.map((timecard) => timecard.id);
  } else if (!Array.isArray(data.timecardIds)) {
    throw validationError('timecardIds must be an array of timecard IDs', 'INVALID_TIMECARD_SELECTION');
  } else {
    timecardIds = [...new Set(data.timecardIds)];
  }
  if (timecardIds.length === 0) throw validationError('Select at least one approved timecard', 'EMPTY_TIMECARD_BATCH');

  const unknownIds = timecardIds.filter((id) => !TIMECARDS.some((timecard) => timecard.id === id));
  if (unknownIds.length > 0) throw validationError(`Unknown timecard ID(s): ${unknownIds.join(', ')}`, 'UNKNOWN_TIMECARD');

  const selected = TIMECARDS.filter((timecard) => timecardIds.includes(timecard.id));
  let failingTimecard = null;

  logger.info('Sending SmartTime batch to EP Payroll', {
    batchId: PRODUCTION.payrollBatchId,
    productionId: PRODUCTION.id,
    timecardCount: selected.length,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 160));
    const lines = selected.map((timecard) => {
      failingTimecard = timecard;
      return { timecardId: timecard.id, crewName: timecard.crewName, union: timecard.union, ...computeTimecardCost(timecard) };
    });
    failingTimecard = null;
    const totalGross = round(lines.reduce((sum, line) => sum + line.gross, 0));
    const totalFringe = round(lines.reduce((sum, line) => sum + line.fringe, 0));
    const duration = Date.now() - startTime;

    incrementMetric('ep_smarttime.payroll_batch_success', { batchId: PRODUCTION.payrollBatchId });
    recordTiming('ep_smarttime.payroll_batch_latency', duration, { batchId: PRODUCTION.payrollBatchId, error: 'false' });

    return {
      success: true,
      batchId: PRODUCTION.payrollBatchId,
      status: 'sent_to_payroll',
      payrollReference: `EPP-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
      payDate: PRODUCTION.payDate,
      timecardCount: lines.length,
      totalGross,
      totalFringe,
      totalLaborCost: round(totalGross + totalFringe),
      lines,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const union = failingTimecard ? failingTimecard.union : 'unknown';
    incrementMetric('ep_smarttime.payroll_batch_failure', { batchId: PRODUCTION.payrollBatchId, union });
    recordTiming('ep_smarttime.payroll_batch_latency', duration, { batchId: PRODUCTION.payrollBatchId, union, error: 'true' });

    logger.error('SmartTime batch failed while sending to EP Payroll', {
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      batchId: PRODUCTION.payrollBatchId,
      timecardId: failingTimecard ? failingTimecard.id : undefined,
      union,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, batchId: PRODUCTION.payrollBatchId, union, alert_path: 'instant' },
      extra: { productionId: PRODUCTION.id, ...(failingTimecard ? { timecardId: failingTimecard.id } : {}) },
    });

    declareDatadogIncident({
      title: 'SmartTime payroll batch failing for IATSE Local 600 timecards',
      summary: `${error.name}: ${error.message}. Batch ${PRODUCTION.payrollBatchId} for ${PRODUCTION.title} cannot be sent to EP Payroll.`,
      runRef: PRODUCTION.payrollBatchId,
      service: SERVICE,
      triggeredBy: data.devinEmail || 'smarttime',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for SmartTime', { error: err.message }));

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/02a5e918.js — computeTimecardCost',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Entertainment Partners SmartTime — Send to Payroll',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '02a5e918',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'batchId', value: PRODUCTION.payrollBatchId },
        { key: 'union', value: union },
      ],
      extra: { productionId: PRODUCTION.id, ...(failingTimecard ? { timecardId: failingTimecard.id } : {}) },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => logger.warn('SmartTime incident follow-up failed', { error: err.message }));

    error.statusCode = 500;
    error.code = 'PAYROLL_BATCH_FAILED';
    throw error;
  }
}

module.exports = {
  PRODUCTION,
  TIMECARDS,
  UNION_FRINGE_RULES,
  REMEDIATION_DIRECTIVE,
  getTimecardBatch,
  sendTimecardsToPayroll,
};
