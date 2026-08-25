const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Visit types a MyBSWHealth patient can book from the scheduling page. The
 * `serviceLine` is the join key into the scheduling rules below.
 */
const VISIT_TYPES = [
  {
    code: 'video-visit',
    name: 'MyBSWHealth Video Visit',
    description: 'Same-day virtual care with a Baylor Scott & White provider',
    serviceLine: 'virtual_care_video',
  },
  {
    code: 'office-visit',
    name: 'Office Visit',
    description: 'In-person appointment at your primary care clinic',
    serviceLine: 'primary_care_office',
  },
  {
    code: 'urgent-care',
    name: 'Urgent Care Walk-In',
    description: 'Same-day in-person care at a BSW Urgent Care location',
    serviceLine: 'urgent_care_walk_in',
  },
];

/**
 * Scheduling rules per service line: how long a slot is held, how far out the
 * booking window runs, and the copay collected at check-in. Every visit type's
 * `serviceLine` must be registered here.
 */
const SCHEDULING_RULES = {
  primary_care_office: {
    label: 'Primary Care Office',
    slotDurationMinutes: 20,
    bookingWindowDays: 45,
    copayUsd: 35,
    requiresReferral: false,
    checkInMinutesBefore: 15,
  },
  urgent_care_walk_in: {
    label: 'Urgent Care Walk-In',
    slotDurationMinutes: 30,
    bookingWindowDays: 2,
    copayUsd: 75,
    requiresReferral: false,
    checkInMinutesBefore: 20,
  },
};

/**
 * Insurance plans accepted for online scheduling, with the share of the copay
 * waived at the time of booking.
 */
const INSURANCE_PLANS = {
  'bswhp-hmo': { label: 'BSW Health Plan HMO', copayWaivedPct: 0 },
  'bswhp-ppo': { label: 'BSW Health Plan PPO', copayWaivedPct: 0 },
  'medicare-advantage': { label: 'BSW SeniorCare Advantage', copayWaivedPct: 100 },
  'self-pay': { label: 'Self-pay', copayWaivedPct: 0 },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Baylor Scott & White MyBSWHealth scheduling vertical:',
  '- Service: `app/services/verticals/d1a01dc3.js`',
  '- Route: `app/routes/verticals/d1a01dc3.js`',
  '- Page: `app/public/verticals/d1a01dc3.html` (served at `/bsw`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findVisitType(visitTypeCode) {
  return VISIT_TYPES.find((type) => type.code === visitTypeCode) || VISIT_TYPES[0];
}

function findInsurancePlan(planCode) {
  return INSURANCE_PLANS[planCode] || INSURANCE_PLANS['self-pay'];
}

/**
 * Hold the requested slot and derive its end time from the service line's
 * slot duration.
 */
function buildSlotHold(visitType, requestedStartIso) {
  const rules = SCHEDULING_RULES[visitType.serviceLine];

  const start = new Date(requestedStartIso);
  const end = new Date(start.getTime() + rules.slotDurationMinutes * 60000);

  return {
    serviceLine: rules.label,
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    slotDurationMinutes: rules.slotDurationMinutes,
    checkInMinutesBefore: rules.checkInMinutesBefore,
    bookingWindowDays: rules.bookingWindowDays,
    requiresReferral: rules.requiresReferral,
  };
}

/**
 * Patient responsibility collected at check-in, after the plan's waiver.
 */
function buildCostEstimate(visitType, planCode) {
  const rules = SCHEDULING_RULES[visitType.serviceLine];
  const plan = findInsurancePlan(planCode);
  const dueUsd = Number((rules.copayUsd * (1 - plan.copayWaivedPct / 100)).toFixed(2));

  return {
    plan: plan.label,
    copayUsd: rules.copayUsd,
    copayWaivedPct: plan.copayWaivedPct,
    estimatedDueAtCheckInUsd: dueUsd,
  };
}

/**
 * Assemble the confirmation shown to the patient.
 */
function buildAppointmentResult(appointmentId, visitType, provider, slot, cost) {
  return {
    appointmentId,
    status: 'scheduled',
    visitType: {
      code: visitType.code,
      name: visitType.name,
    },
    provider,
    slot,
    cost,
    myBswReminderQueued: true,
  };
}

/**
 * Schedules a MyBSWHealth appointment and returns the confirmation.
 */
async function scheduleVisit(data) {
  const startTime = Date.now();
  const appointmentId = uuidv4();

  const patientMrn = String(data.patientMrn || '').trim();
  const requestedStart = String(data.requestedStart || '').trim();
  const parsedStart = new Date(requestedStart);

  if (!patientMrn || !requestedStart || Number.isNaN(parsedStart.getTime())) {
    const validationError = new Error('Enter your medical record number and pick an available appointment time.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_SCHEDULING_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Scheduling MyBSWHealth appointment', {
    appointmentId,
    visitType: data.visitType,
    insurancePlan: data.insurancePlan,
    service: 'customer-d1a01dc3-patient-scheduling',
    route: '/api/d1a01dc3/schedule-visit',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const visitType = findVisitType(data.visitType);
    const slot = buildSlotHold(visitType, requestedStart);
    const cost = buildCostEstimate(visitType, data.insurancePlan);
    const result = buildAppointmentResult(appointmentId, visitType, {
      name: data.providerName || 'Alicia R. Vance, MD',
      specialty: 'Family Medicine',
      location: data.location || 'BSW Family Medicine \u2014 Dallas Uptown',
    }, slot, cost);

    const duration = Date.now() - startTime;

    incrementMetric('patient_scheduling.appointment_success', {
      route: '/api/d1a01dc3/schedule-visit',
      visitType: visitType.code,
      insurancePlan: data.insurancePlan || 'self-pay',
    });
    recordTiming('patient_scheduling.appointment_latency', duration, {
      route: '/api/d1a01dc3/schedule-visit',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('patient_scheduling.appointment_failure', {
      route: '/api/d1a01dc3/schedule-visit',
      errorClass: error.name,
      visitType: data.visitType,
    });
    recordTiming('patient_scheduling.appointment_latency', duration, {
      route: '/api/d1a01dc3/schedule-visit',
      error: 'true',
    });

    logger.error('Appointment scheduling failed', {
      appointmentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      visitType: data.visitType,
      insurancePlan: data.insurancePlan,
      service: 'customer-d1a01dc3-patient-scheduling',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/d1a01dc3/schedule-visit',
        service: 'customer-d1a01dc3-patient-scheduling',
        visitType: data.visitType,
      },
      extra: {
        appointmentId,
        insurancePlan: data.insurancePlan,
        requestedStart: data.requestedStart,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/d1a01dc3.js \u2014 buildSlotHold',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-d1a01dc3-patient-scheduling',
      verticalLabel: 'Patient Scheduling',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'd1a01dc3',
      slackMemberId: 'U0BKV8PTK6F',
      tags: [
        { key: 'route', value: '/api/d1a01dc3/schedule-visit' },
        { key: 'service', value: 'customer-d1a01dc3-patient-scheduling' },
        { key: 'visitType', value: data.visitType },
        { key: 'insurancePlan', value: data.insurancePlan },
      ],
      extra: {
        appointmentId,
        insurancePlan: data.insurancePlan,
        requestedStart: data.requestedStart,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-d1a01dc3-patient-scheduling@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for patient scheduling error', {
        error: err.message,
        appointmentId,
      });
    });

    throw error;
  }
}

module.exports = {
  scheduleVisit,
  REMEDIATION_DIRECTIVE,
  VISIT_TYPES,
  SCHEDULING_RULES,
  INSURANCE_PLANS,
};
