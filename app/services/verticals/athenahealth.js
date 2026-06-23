const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Specialist directory for referral routing
 */
const SPECIALISTS = [
  { id: 'DR-CARD-401', name: 'Dr. Michael Torres', specialty: 'cardiology', npi: '1234567890', accepting: true },
  { id: 'DR-ORTH-502', name: 'Dr. Lisa Park', specialty: 'orthopedics', npi: '2345678901', accepting: true },
  { id: 'DR-NEUR-603', name: 'Dr. James Wu', specialty: 'neurology', npi: '3456789012', accepting: true },
  { id: 'DR-ENDO-704', name: 'Dr. Raj Patel', specialty: 'endocrinology', npi: '4567890123', accepting: true },
  { id: 'DR-GAST-805', name: 'Dr. Nina Gupta', specialty: 'gastroenterology', npi: '5678901234', accepting: true },
];

/**
 * Patient insurance authorization rules by payer
 */
const PAYER_AUTH_RULES = {
  'blue-cross': { requiresAuth: true, validDays: 90, copayTier: 'specialist' },
  'aetna': { requiresAuth: true, validDays: 60, copayTier: 'specialist' },
  'united': { requiresAuth: false, validDays: null, copayTier: 'standard' },
  'cigna': { requiresAuth: true, validDays: 45, copayTier: 'specialist' },
};

/**
 * Patient records with insurance details.
 * NOTE: Patient ATH-2026-08471 has insuranceDetails set but copaySchedule
 * is only populated when the payer provides it upstream. For Blue Cross
 * the schedule arrives asynchronously and may not be present at referral time.
 */
const PATIENTS = {
  'ATH-2026-08471': {
    name: 'Emily Rodriguez',
    dob: '1985-03-14',
    pcp: 'DR-PCP-101',
    insuranceDetails: {
      payerId: 'blue-cross',
      memberId: 'BCB-998877-01',
      groupNumber: 'GRP-4400',
      copaySchedule: null, // populated asynchronously by payer feed
    },
  },
  'ATH-2026-07322': {
    name: 'Michael Thompson',
    dob: '1972-11-02',
    pcp: 'DR-PCP-101',
    insuranceDetails: {
      payerId: 'united',
      memberId: 'UHC-112233-05',
      groupNumber: 'GRP-7700',
      copaySchedule: { specialist: 45, standard: 25 },
    },
  },
};

/**
 * Recent referral history for display
 */
const REFERRALS = [
  { id: 'REF-001', date: '2026-06-20', patient: 'Michael Thompson', specialty: 'Orthopedics', specialist: 'Dr. Lisa Park', status: 'accepted' },
  { id: 'REF-002', date: '2026-06-19', patient: 'Angela Martinez', specialty: 'Endocrinology', specialist: 'Dr. Raj Patel', status: 'scheduled' },
  { id: 'REF-003', date: '2026-06-17', patient: 'David Kim', specialty: 'Neurology', specialist: 'Dr. James Wu', status: 'pending' },
  { id: 'REF-004', date: '2026-06-15', patient: 'Patricia Williams', specialty: 'Gastroenterology', specialist: 'Dr. Nina Gupta', status: 'accepted' },
];

/**
 * Validate the referral authorization against payer rules.
 */
function validateAuthorization(patient, authNumber) {
  const payerId = patient.insuranceDetails.payerId;
  const rules = PAYER_AUTH_RULES[payerId];
  if (!rules) return { valid: false, reason: 'Unknown payer' };
  if (!rules.requiresAuth) return { valid: true, reason: 'No auth required' };
  if (!authNumber) return { valid: false, reason: 'Authorization required by payer' };
  return { valid: true, authNumber, expiresInDays: rules.validDays };
}

/**
 * Calculate the patient's estimated copay for the referral visit.
 * BUG: copaySchedule is null for Blue Cross patients whose payer feed
 * hasn't populated it yet; accessing .specialist crashes.
 */
function calculateCopay(patient, visitType) {
  const schedule = patient.insuranceDetails.copaySchedule;
  const copayAmount = schedule[visitType];
  return { amount: copayAmount, currency: 'USD' };
}

/**
 * Build the referral order for transmission via athenaNet.
 */
function buildReferralOrder(referralData, specialist, copay, auth) {
  return {
    orderId: `ORD-${Date.now()}`,
    referringProvider: referralData.referringProvider,
    specialist: { id: specialist.id, name: specialist.name, npi: specialist.npi },
    patient: referralData.patientMrn,
    specialty: referralData.specialty,
    priority: referralData.priority,
    diagnosisCode: referralData.diagnosisCode,
    authorization: auth,
    estimatedCopay: copay,
    clinicalNotes: referralData.clinicalNotes,
    transmissionMethod: 'athenaNet-secure',
    createdAt: new Date().toISOString(),
  };
}

/**
 * Process a specialist referral submission.
 */
async function processReferral(data) {
  const startTime = Date.now();
  const referralId = uuidv4();

  logger.info('Processing specialist referral', {
    referralId,
    patientMrn: data.patientMrn,
    specialty: data.specialty,
    specialistId: data.specialistId,
    priority: data.priority,
    service: 'athenaone-referral-mgmt',
    route: '/api/athenahealth/referral',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const patient = PATIENTS[data.patientMrn];
    if (!patient) {
      throw Object.assign(new Error(`Patient not found: ${data.patientMrn}`), { code: 'PATIENT_NOT_FOUND' });
    }

    const specialist = SPECIALISTS.find((s) => s.id === data.specialistId);
    if (!specialist) {
      throw Object.assign(new Error(`Specialist not found: ${data.specialistId}`), { code: 'SPECIALIST_NOT_FOUND' });
    }

    const auth = validateAuthorization(patient, data.authNumber);
    const copay = calculateCopay(patient, 'specialist');
    const order = buildReferralOrder(data, specialist, copay, auth);

    const duration = Date.now() - startTime;

    incrementMetric('referral.success', {
      route: '/api/athenahealth/referral',
      specialty: data.specialty,
    });
    recordTiming('referral.latency', duration, {
      route: '/api/athenahealth/referral',
    });

    return {
      success: true,
      referralId,
      order,
      status: 'transmitted',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('referral.failure', {
      route: '/api/athenahealth/referral',
      errorClass: error.name,
      specialty: data.specialty,
    });
    recordTiming('referral.latency', duration, {
      route: '/api/athenahealth/referral',
      error: 'true',
    });

    logger.error('Specialist referral failed', {
      referralId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      patientMrn: data.patientMrn,
      specialty: data.specialty,
      service: 'athenaone-referral-mgmt',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/athenahealth/referral',
        service: 'athenaone-referral-mgmt',
        specialty: data.specialty,
      },
      extra: {
        referralId,
        patientMrn: data.patientMrn,
        specialistId: data.specialistId,
        priority: data.priority,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/athenahealth.js \u2014 calculateCopay',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'athenaone-referral-mgmt',
      verticalLabel: 'athenaOne Referral Management',
      customer: 'athenahealth',
      tags: [
        { key: 'route', value: '/api/athenahealth/referral' },
        { key: 'service', value: 'athenaone-referral-mgmt' },
        { key: 'specialty', value: data.specialty },
      ],
      extra: { referralId, patientMrn: data.patientMrn, specialistId: data.specialistId, priority: data.priority },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'athenaone-referral@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from referral error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processReferral, validateAuthorization, calculateCopay, SPECIALISTS, PATIENTS, REFERRALS };
