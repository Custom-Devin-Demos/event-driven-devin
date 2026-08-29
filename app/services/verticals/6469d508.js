const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Visit types a patient can request from the homepage appointment flow.
 */
const VISIT_TYPES = {
  primary_care: {
    code: 'primary_care',
    name: 'Primary Care Visit',
    network: 'mshs',
    durationMinutes: 30,
  },
  specialty_care: {
    code: 'specialty_care',
    name: 'Specialty Care Consultation',
    network: 'mshs',
    durationMinutes: 45,
  },
  urgent_care: {
    code: 'urgent_care',
    name: 'Urgent Care / Walk-In',
    network: 'mshs',
    durationMinutes: 20,
  },
  telehealth: {
    code: 'telehealth',
    name: 'Video Visit',
    network: 'mshs',
    durationMinutes: 15,
  },
};

/**
 * Scheduling windows per network and visit lane: booking horizon, first
 * available offset, and the coordination desk that owns the calendar.
 */
const SCHEDULING_WINDOWS = {
  'mshs-primary-care': { horizonDays: 30, firstAvailableHours: 48, desk: 'ambulatory-access-center' },
  'mshs-specialty-care': { horizonDays: 60, firstAvailableHours: 96, desk: 'specialty-coordination' },
  'mshs-urgent-care': { horizonDays: 1, firstAvailableHours: 1, desk: 'walk-in-network' },
  'mshs-telehealth': { horizonDays: 14, firstAvailableHours: 4, desk: 'digital-health-desk' },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `Custom-Devin-Demos/event-driven-devin`',
  '',
  'The failing code path is the health system appointment inquiry vertical:',
  '- Service: `app/services/verticals/6469d508.js`',
  '- Route: `app/routes/verticals/6469d508.js`',
  '- Page: `app/public/verticals/6469d508.html` (served at `/6469d508`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findVisitType(code) {
  return VISIT_TYPES[code] || VISIT_TYPES.primary_care;
}

/**
 * Build the calendar lane identifier for a network and visit type pairing.
 */
function buildCalendarLane(visitType) {
  return `${visitType.network}-${visitType.code.replace(/_/g, '-')}`;
}

/**
 * Normalize the raw appointment request into the shape the scheduler
 * consumes.
 */
function normalizeInquiry(data, visitType) {
  return {
    visitCode: visitType.code,
    zipCode: String(data.zipCode || '10029').trim(),
    lane: buildCalendarLane(visitType),
    requestedAt: new Date().toISOString(),
  };
}

/**
 * Reserve the earliest slot on the lane's calendar and resolve the
 * coordination desk that will confirm the appointment.
 */
function reserveVisitSlot(inquiry, visitType) {
  const window = SCHEDULING_WINDOWS[inquiry.lane];

  if (!window) {
    const error = new Error(`No scheduling window configured for calendar lane "${inquiry.lane}"`);
    error.code = 'SCHEDULING_WINDOW_NOT_FOUND';
    throw error;
  }

  const firstAvailable = new Date(Date.now() + window.firstAvailableHours * 3600000);

  return {
    visitCode: visitType.code,
    visitName: visitType.name,
    durationMinutes: visitType.durationMinutes,
    coordinationDesk: window.desk,
    horizonDays: window.horizonDays,
    firstAvailableAt: firstAvailable.toISOString(),
  };
}

/**
 * Assemble the confirmation shown to the patient.
 */
function buildConfirmation(referenceNumber, inquiry, slot) {
  return {
    referenceNumber,
    status: 'received',
    visitCode: slot.visitCode,
    visitName: slot.visitName,
    durationMinutes: slot.durationMinutes,
    coordinationDesk: slot.coordinationDesk,
    zipCode: inquiry.zipCode,
    firstAvailableAt: slot.firstAvailableAt,
    confirmationCallQueued: true,
  };
}

/**
 * Submits an appointment inquiry from the health system homepage.
 */
async function submitAppointmentInquiry(data) {
  const startTime = Date.now();
  const referenceNumber = `MS-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Submitting appointment inquiry', {
    referenceNumber,
    visitType: data.visitType,
    zipCode: data.zipCode,
    service: 'customer-6469d508-inquiry',
    route: '/api/6469d508/inquiry',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const visitType = findVisitType(data.visitType);
    const inquiry = normalizeInquiry(data, visitType);
    const slot = reserveVisitSlot(inquiry, visitType);
    const result = buildConfirmation(referenceNumber, inquiry, slot);

    const duration = Date.now() - startTime;

    incrementMetric('appointment_inquiry.success', {
      route: '/api/6469d508/inquiry',
      visitType: visitType.code,
    });
    recordTiming('appointment_inquiry.latency', duration, {
      route: '/api/6469d508/inquiry',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('appointment_inquiry.failure', {
      route: '/api/6469d508/inquiry',
      errorClass: error.name,
      visitType: data.visitType,
    });
    recordTiming('appointment_inquiry.latency', duration, {
      route: '/api/6469d508/inquiry',
      error: 'true',
    });

    logger.error('Appointment inquiry failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      visitType: data.visitType,
      zipCode: data.zipCode,
      service: 'customer-6469d508-inquiry',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/6469d508/inquiry',
        service: 'customer-6469d508-inquiry',
        visitType: data.visitType,
      },
      extra: {
        referenceNumber,
        zipCode: data.zipCode,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6469d508.js \u2014 reserveVisitSlot',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId || process.env.DEVIN_USER_ID_6469D508 || '',
      devinOrgId: data.devinOrgId || 'org-b85810a801634b8d8030a6fe5582dbfa',
      service: 'customer-6469d508-inquiry',
      verticalLabel: 'Health System Appointment Inquiry',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '6469d508',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/6469d508/inquiry' },
        { key: 'service', value: 'customer-6469d508-inquiry' },
        { key: 'visitType', value: data.visitType },
      ],
      extra: {
        referenceNumber,
        zipCode: data.zipCode,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-6469d508-inquiry@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for appointment inquiry error', {
        error: err.message,
        referenceNumber,
      });
    });

    throw error;
  }
}

module.exports = {
  submitAppointmentInquiry,
  buildCalendarLane,
  reserveVisitSlot,
  VISIT_TYPES,
  SCHEDULING_WINDOWS,
  REMEDIATION_DIRECTIVE,
};
