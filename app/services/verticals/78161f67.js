const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/78161f67/apply';
const SERVICE = 'e-application-api';

/**
 * Nursery facilities accepting applications in this intake, keyed by facility
 * id. `openings` is the number of places the facility reported for the intake.
 */
const FACILITY_CONFIGS = {
  chuo:      { label: 'ひだまり中央保育園', ward: 'chuo', openings: 12, type: 'nursery' },
  sakura:    { label: 'さくらが丘こども園', ward: 'kita', openings: 8, type: 'certified-center' },
  minami:    { label: 'みなみかわ保育園', ward: 'minami', openings: 6, type: 'nursery' },
};

/**
 * The intake currently open for applications (received count per facility).
 */
const INTAKE = {
  id: 'r8-april-nursery-1st',
  title: '令和8年度 4月入所 保育所等入所申込（一次募集）',
  opensAt: '2026-11-04T09:00:00+09:00',
  closesAt: '2026-11-28T17:00:00+09:00',
  received: { chuo: 9, sakura: 5, minami: 2 },
};

/**
 * Retrieve the facility configuration, falling back to the central nursery
 * for ids the city has since merged.
 */
function getFacilityConfig(facilityId) {
  return FACILITY_CONFIGS[facilityId] || FACILITY_CONFIGS.chuo;
}

/**
 * Issue the application's receipt: a numbered receipt while the facility still
 * reports openings, otherwise a waiting-list receipt.
 */
function issueReceipt(config, received) {
  const remaining = config.openings - received;
  if (remaining > 0) {
    return {
      issued: { number: received + 1, status: 'received', remaining: remaining - 1 },
    };
  }
  return {
    issued: { number: null, status: 'waitlisted', position: received - config.openings + 1 },
  };
}

/**
 * Submit a nursery admission application for the open intake.
 */
async function submitApplication(data) {
  const startTime = Date.now();
  const applicationId = uuidv4();

  logger.info('Submitting nursery application', {
    applicationId,
    intakeId: INTAKE.id,
    facilityId: data.facilityId,
    applicantName: data.applicantName,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));

    const config = getFacilityConfig(data.facilityId);
    const received = INTAKE.received[data.facilityId] || 0;
    const receipt = issueReceipt(config, received);

    const duration = Date.now() - startTime;

    incrementMetric('application.success', { route: ROUTE, facility: data.facilityId });
    recordTiming('application.latency', duration, { route: ROUTE });

    return {
      success: true,
      applicationId,
      intakeId: INTAKE.id,
      facilityId: data.facilityId,
      facilityLabel: config.label,
      status: receipt.allocation.status,
      receiptNumber: receipt.allocation.number,
      applicantName: data.applicantName,
      ageClass: data.ageClass,
      ward: data.ward,
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('application.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('application.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Nursery application failed', {
      applicationId,
      intakeId: INTAKE.id,
      facilityId: data.facilityId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, facility: data.facilityId, alert_path: 'instant' },
      extra: { applicationId, intakeId: INTAKE.id, applicantName: data.applicantName },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/78161f67.js — submitApplication',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: '保育所入所申込（電子申請）',
      locale: 'ja',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alert_path', value: 'instant' },
      ],
      extra: { applicationId, intakeId: INTAKE.id, facilityId: data.facilityId, applicantName: data.applicantName },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'e-application@3.1.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from application error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { submitApplication, FACILITY_CONFIGS, INTAKE };
