const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/3a2b7a6d/intake';
const SERVICE = '3a2b7a6d-intake-api';

/** Fictional clinicians and patients — demo data only. */
const CLINICIANS = {
  'LH-201': { name: 'Dr. Amara Okafor', specialty: 'Family Medicine', location: 'Lakeshore Primary Care — Evanston' },
  'LH-305': { name: 'Dr. Ben Castillo', specialty: 'Endocrinology', location: 'Lakeshore Specialty Center — Loop' },
};

const PATIENTS = {
  'MRN-100482': { name: 'Jordan Rivera', dob: '1984-03-12', insurance: 'Summit Gold PPO' },
  'MRN-100517': { name: 'Elena Brooks', dob: '1957-11-02', insurance: 'Medicare Advantage' },
};

const VISIT_TYPES = {
  'in-person': { label: 'In-person visit', durationMin: 30 },
  telehealth: { label: 'Video visit (telehealth)', durationMin: 20 },
};

/** Intake packet each visit channel must collect before the slot is booked. */
const INTAKE_PACKETS = {
  'in-person': { consents: ['HIPAA notice', 'Financial responsibility'], questionnaires: ['Health history', 'Medication list'] },
  virtual: { consents: ['HIPAA notice', 'Financial responsibility', 'Telehealth consent'], questionnaires: ['Health history', 'Medication list'] },
};

function packetFor(visitType) {
  return INTAKE_PACKETS[visitType];
}

function buildChecklist(packet, completed) {
  const items = [...packet.consents, ...packet.questionnaires];
  return items.map((item) => ({ item, done: completed.includes(item) }));
}

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

async function submitIntake(data) {
  const startTime = Date.now();
  const appointmentId = `APT-${uuidv4().slice(0, 8).toUpperCase()}`;
  logger.info('Submitting appointment intake', { appointmentId, mrn: data.mrn, clinicianId: data.clinicianId, visitType: data.visitType, service: SERVICE });

  const patient = PATIENTS[data.mrn];
  const clinician = CLINICIANS[data.clinicianId];
  if (!patient || !clinician) throw new ValidationError('Unknown patient or clinician');
  if (!VISIT_TYPES[data.visitType]) throw new ValidationError('Unknown visit type');

  try {
    const checklist = buildChecklist(packetFor(data.visitType), data.completedForms || []);
    const outstanding = checklist.filter((c) => !c.done).map((c) => c.item);
    incrementMetric('intake.success', { route: ROUTE, visitType: data.visitType });
    recordTiming('intake.latency', Date.now() - startTime, { route: ROUTE });
    return {
      success: true, appointmentId, patient: patient.name, clinician: clinician.name, location: clinician.location,
      visit: VISIT_TYPES[data.visitType].label, slot: data.slot, checklist, outstanding,
      status: outstanding.length ? 'booked-intake-pending' : 'booked',
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    incrementMetric('intake.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('intake.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('Appointment intake failed', { appointmentId, error: error.message, errorClass: error.name, visitType: data.visitType });
    Sentry.captureException(error, { tags: { route: ROUTE, service: SERVICE, visitType: data.visitType }, extra: { appointmentId, mrn: data.mrn } });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/3a2b7a6d.js — submitIntake',
      errorType: error.name || 'Error', errorValue: error.message,
      devinUserId: data.devinUserId, devinEmail: data.devinEmail, devinOrgId: data.devinOrgId,
      service: SERVICE, verticalLabel: 'Patient Appointment Intake (Provider)', customer: '3a2b7a6d',
      tags: [{ key: 'route', value: ROUTE }, { key: 'service', value: SERVICE }, { key: 'visitType', value: String(data.visitType) }],
      extra: { appointmentId, mrn: data.mrn, clinicianId: data.clinicianId },
      level: 'error', platform: 'node', firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || '3a2b7a6d@1.0.0',
      environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    }).catch((err) => logger.error('Failed to trigger Devin session from intake error', { error: err.message }));
    throw error;
  }
}

module.exports = { submitIntake, packetFor, CLINICIANS, PATIENTS, VISIT_TYPES, INTAKE_PACKETS, ValidationError };
