const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Medical providers for the demo
 */
const PROVIDERS = [
  { id: 'DR-101', name: 'Dr. Sarah Kim', department: 'primary-care', specialty: 'Internal Medicine', available: true },
  { id: 'DR-102', name: 'Dr. James Patel', department: 'cardiology', specialty: 'Cardiology', available: true },
  { id: 'DR-103', name: 'Dr. Maria Santos', department: 'dermatology', specialty: 'Dermatology', available: true },
  { id: 'DR-104', name: 'Dr. Robert Chen', department: 'orthopedics', specialty: 'Orthopedic Surgery', available: false },
  { id: 'DR-105', name: 'Dr. Emily Zhao', department: 'neurology', specialty: 'Neurology', available: true },
];

/**
 * Patient insurance plans — coverage periods end on 2026-12-31
 */
const PATIENT_PLANS = {
  'PAT-2001': { plan: 'Gold', copayAmount: 20, coverageEndDate: '2026-12-31', deductibleRemaining: 250 },
  'PAT-2002': { plan: 'Silver', copayAmount: 35, coverageEndDate: '2026-12-31', deductibleRemaining: 800 },
  'PAT-2003': { plan: 'Bronze', copayAmount: 50, coverageEndDate: '2026-12-31', deductibleRemaining: 1500 },
};

/**
 * Build an appointment date from form inputs.
 */
function buildAppointmentDate(year, month, day) {
  return new Date(year, month, day);
}

/**
 * Check if an appointment date falls within the patient's coverage period.
 */
function getCoveragePeriod(patientId, appointmentDate) {
  const plan = PATIENT_PLANS[patientId];
  if (!plan) return null;

  const coverageEnd = new Date(plan.coverageEndDate);
  if (appointmentDate > coverageEnd) return null;

  return plan;
}

/**
 * Schedule a medical appointment.
 */
async function scheduleAppointment(data) {
  const startTime = Date.now();
  const appointmentId = uuidv4();

  logger.info('Scheduling appointment', {
    appointmentId,
    patientId: data.patientId,
    providerId: data.providerId,
    department: data.department,
    service: 'healthcare-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const apptDate = buildAppointmentDate(data.year, data.month, data.day);
    const coverage = getCoveragePeriod(data.patientId, apptDate);

    const copay = coverage.copayAmount;
    const provider = PROVIDERS.find((p) => p.id === data.providerId);

    const duration = Date.now() - startTime;

    incrementMetric('appointment.success', {
      route: '/api/healthcare/appointment',
      department: data.department,
    });
    recordTiming('appointment.latency', duration, {
      route: '/api/healthcare/appointment',
    });

    return {
      success: true,
      appointmentId,
      patientId: data.patientId,
      provider: provider ? provider.name : data.providerId,
      department: data.department,
      date: apptDate.toISOString().split('T')[0],
      copay,
      status: 'confirmed',
      scheduledAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('appointment.failure', {
      route: '/api/healthcare/appointment',
      errorClass: error.name,
    });
    recordTiming('appointment.latency', duration, {
      route: '/api/healthcare/appointment',
      error: 'true',
    });

    logger.error('Appointment scheduling failed', {
      appointmentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      patientId: data.patientId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/healthcare/appointment',
        service: 'healthcare-api',
        department: data.department,
      },
      extra: { appointmentId, patientId: data.patientId, providerId: data.providerId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/healthcare.js — scheduleAppointment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'healthcare-api',
      verticalLabel: 'Appointment Scheduling',
      tags: [
        { key: 'route', value: '/api/healthcare/appointment' },
        { key: 'service', value: 'healthcare-api' },
      ],
      extra: { appointmentId, patientId: data.patientId, providerId: data.providerId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'carepoint@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from appointment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { scheduleAppointment, PROVIDERS, PATIENT_PLANS };
