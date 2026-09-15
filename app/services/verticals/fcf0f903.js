const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  PATIENTS,
  COVERAGE_TIERS,
  THERAPIES,
  findPatient,
  findTherapy,
} = require('./fcf0f903-patients');

const SERVICE = 'customer-fcf0f903-patient-access';
const ROUTE = '/api/fcf0f903/enrollment';
const ESTIMATE_ROUTE = '/api/fcf0f903/copay-estimate';

/** Slack member to page when an enrollment fails and no requester email is known. */
const ONCALL_SLACK_MEMBER_ID = process.env.DEMO_ONCALL_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the specialty-pharma Patient Access vertical:',
  '- Service: `app/services/verticals/fcf0f903.js`',
  '- Patient records & coverage tiers: `app/services/verticals/fcf0f903-patients.js`',
  '- Route: `app/routes/verticals/fcf0f903.js`',
  '- Page: `app/public/verticals/fcf0f903.html` (served at `/fcf0f903` and `/patient-access`)',
  '- Prevention control: `scripts/fcf0f903-copay-audit.js` (`npm run audit:copay`)',
  '',
  '*Treat this as a field-migration defect, not a one-line crash.* The FY26 benefits refresh moved the verified coverage tier on patient records to a new location (see `fcf0f903-patients.js`). Every consumer of the old location is broken; only one of them crashes.',
  '',
  '*Remediation plan — once the crash is root-caused, run these three workstreams in parallel as child sessions, wait for them, then summarize in the ServiceNow incident:*',
  '1. *Blast radius in code* — find every consumer of the moved field in the service (enrollment AND copay-estimate paths, telemetry included). The estimate path does not crash: it silently falls back to the Standard tier, so Specialty Commercial and Foundation Assistance patients are quoted the full $150 standard copay and told they are not assistance-eligible when their tier entitles them to $0–$10 per fill. The only signal is the `copay_estimate.quoted` metric carrying `tier:Standard` on patients whose verified tier is not Standard. Route all consumers through one shared resolver that fails loudly when a tier cannot be resolved, add regression tests for both paths, run `npm test` and `npm run lint`.',
  '2. *Blast radius in ServiceNow* — using the same Table API credentials as the incident write-back, query open incidents in assignment group "Patient Access Platform Engineering" (state < 6) that predate this incident and mention copay, assistance or tier. Decide which are the silent symptom of this same defect. For each: add a work note linking this incident and the fix PR, set `parent_incident` to this incident sys_id, and resolve it (`state` 6, `close_code` "Solution provided"). Report their numbers and count.',
  '3. *Prevention* — run `npm run audit:copay`. It resolves the copay-assistance benefit for every patient record through both the enrollment and estimate paths and exits non-zero on any unresolved or silently downgraded tier; it is not wired into CI, which is why this shipped. Wire it into `npm test` (or the CI workflow) so a coverage-tier gap fails before it ships.',
  '',
  'Fold all code workstreams into a single pull request against `main`. If a child session cannot reach ServiceNow, perform workstream 2 from the parent session. The final ServiceNow work note must state: incidents linked and resolved (numbers), routes fixed, prevention control added, PR URL.',
].join('\n');

/**
 * Resolve the copay-assistance benefit a patient enrolls into from the
 * coverage tier verified during benefits investigation.
 */
function resolveEnrollmentBenefit(patient) {
  return COVERAGE_TIERS[patient.coverageTier];
}

/**
 * Resolve the benefit used to quote a copay estimate. Patients whose benefits
 * investigation has not completed fall back to the Standard tier.
 */
function resolveEstimateBenefit(patient) {
  return COVERAGE_TIERS[patient.coverageTier || 'commercial-standard'];
}

/**
 * Confirm the therapy is covered under the patient's benefit before a program
 * enrollment is created. Returns the annual benefit the program will fund.
 */
function assertAssistanceCoverage(benefit, therapy) {
  if (!benefit.assistanceEligible) {
    const error = new Error(`${therapy.name} is not eligible for copay assistance under the ${benefit.label} tier`);
    error.name = 'EligibilityError';
    error.statusCode = 422;
    error.code = 'NOT_ASSISTANCE_ELIGIBLE';
    throw error;
  }
  return Math.min(benefit.annualBenefitCap, (therapy.listPrice - benefit.patientCopay) * 12);
}

/**
 * Assemble the confirmation shown after a successful enrollment.
 */
function buildConfirmation(enrollmentId, patient, therapy, benefit, annualBenefit) {
  return {
    enrollmentId,
    status: 'enrolled',
    patient: patient.name,
    therapy: therapy.name,
    tier: benefit.label,
    patientCopay: benefit.patientCopay,
    annualBenefit,
    plan: patient.coverage.plan,
    enrolledAt: new Date().toISOString(),
  };
}

function validateRequest(patient, therapy, data) {
  if (!patient) {
    const error = new Error(`Unknown patient record: ${data.patientId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'PATIENT_NOT_FOUND';
    throw error;
  }

  if (!therapy) {
    const error = new Error('Therapy is not dispensed through the Aravia patient-access hub');
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'THERAPY_NOT_SUPPORTED';
    throw error;
  }
}

/**
 * Enroll a patient in the copay-assistance program for a specialty therapy.
 */
async function submitEnrollment(data) {
  const startTime = Date.now();
  const enrollmentId = uuidv4();
  const patient = findPatient(data.patientId);
  const therapy = findTherapy(data.therapyId);

  logger.info('Submitting copay-assistance enrollment', {
    enrollmentId,
    patientId: data.patientId,
    therapyId: data.therapyId,
    service: SERVICE,
    route: ROUTE,
  });

  validateRequest(patient, therapy, data);

  if (data.consent !== true) {
    const error = new Error('Patient authorization is required before enrollment');
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'CONSENT_REQUIRED';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const benefit = resolveEnrollmentBenefit(patient);
    const annualBenefit = assertAssistanceCoverage(benefit, therapy);
    const confirmation = buildConfirmation(enrollmentId, patient, therapy, benefit, annualBenefit);

    incrementMetric('enrollment.completed', {
      route: ROUTE,
      indication: therapy.indication,
    });
    recordTiming('enrollment.latency', Date.now() - startTime, {
      route: ROUTE,
      error: 'false',
    });

    logger.info('Copay-assistance enrollment completed', {
      enrollmentId,
      patient: patient.name,
      therapy: therapy.name,
      tier: benefit.label,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('enrollment.failure', {
      route: ROUTE,
      errorClass: error.name,
      patientId: patient.id,
    });
    recordTiming('enrollment.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    if (error.name === 'EligibilityError') {
      throw error;
    }

    logger.error('Copay-assistance enrollment failed', {
      enrollmentId,
      patient: patient.name,
      therapy: therapy.name,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        route: ROUTE,
        patientId: patient.id,
      },
      extra: {
        enrollmentId,
        therapy: therapy.name,
        coverageTier: patient.coverage.tier,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/fcf0f903.js \u2014 assertAssistanceCoverage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Patient Access Enrollment',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'fcf0f903',
      slackMemberId: data.devinEmail ? '' : ONCALL_SLACK_MEMBER_ID,
      slackMemberIdFallback: ONCALL_SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'patientId', value: patient.id },
      ],
      extra: {
        enrollmentId,
        therapy: therapy.name,
        coverageTier: patient.coverage.tier,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for enrollment error', {
        enrollmentId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

/**
 * Quote the out-of-pocket copay a patient can expect for a specialty therapy.
 */
async function estimateCopay(data) {
  const startTime = Date.now();
  const estimateId = uuidv4();
  const patient = findPatient(data.patientId);
  const therapy = findTherapy(data.therapyId);
  const fills = Number(data.fills) || 1;

  logger.info('Estimating copay', {
    estimateId,
    patientId: data.patientId,
    therapyId: data.therapyId,
    fills,
    service: SERVICE,
    route: ESTIMATE_ROUTE,
  });

  validateRequest(patient, therapy, data);

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const benefit = resolveEstimateBenefit(patient);
    const perFill = benefit.patientCopay;
    const programPays = benefit.assistanceEligible
      ? Math.min(benefit.annualBenefitCap, (therapy.listPrice - perFill) * fills)
      : 0;

    incrementMetric('copay_estimate.quoted', {
      route: ESTIMATE_ROUTE,
      tier: benefit.label,
      patientId: patient.id,
    });
    recordTiming('copay_estimate.latency', Date.now() - startTime, {
      route: ESTIMATE_ROUTE,
      error: 'false',
    });

    return {
      estimateId,
      status: 'quoted',
      patient: patient.name,
      therapy: therapy.name,
      tier: benefit.label,
      assistanceEligible: benefit.assistanceEligible,
      listPrice: therapy.listPrice,
      patientCopay: perFill,
      fills,
      patientPays: perFill * fills,
      programPays,
      plan: patient.coverage.plan,
      quotedAt: new Date().toISOString(),
    };
  } catch (error) {
    recordTiming('copay_estimate.latency', Date.now() - startTime, {
      route: ESTIMATE_ROUTE,
      error: 'true',
    });

    if (error.name === 'ValidationError') {
      throw error;
    }

    logger.error('Copay estimate failed', {
      estimateId,
      patientId: patient.id,
      error: error.message,
      errorClass: error.name,
      durationMs: Date.now() - startTime,
      service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        route: ESTIMATE_ROUTE,
        patientId: patient.id,
      },
      extra: {
        estimateId,
        therapy: therapy.name,
        coverageTier: patient.coverage.tier,
      },
    });
    throw error;
  }
}

module.exports = {
  submitEnrollment,
  estimateCopay,
  PATIENTS,
  THERAPIES,
};
