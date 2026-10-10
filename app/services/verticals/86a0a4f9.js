const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  PROGRAM_CONFIG,
  PATIENTS,
  MEDICATIONS,
  findPatient,
  findMedication,
} = require('./86a0a4f9-patients');

const SERVICE = 'customer-86a0a4f9-savings-card';
const CUSTOMER = '86a0a4f9';
const ROUTE = '/api/86a0a4f9/savings-card';
const ESTIMATE_ROUTE = '/api/86a0a4f9/cost-estimate';
const ASSIGNMENT_GROUP = 'Lilly Patient Services Platform Engineering';
const PROGRAM_YEAR = 2026;

/** Coverage default applied to patients whose benefits classification has not been mapped. */
const DEFAULT_COVERAGE = 'commercial_covered';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The incident description is the only context Devin receives from the
 * ServiceNow dispatch, so the repository to remediate has to be named
 * explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Lilly LillyDirect savings card & pharmacy cost vertical:',
  '- Service: `app/services/verticals/86a0a4f9.js`',
  '- Patient records, savings-program configuration & medication catalog: `app/services/verticals/86a0a4f9-patients.js`',
  '- Route: `app/routes/verticals/86a0a4f9.js`',
  '- Page: `app/public/verticals/86a0a4f9.html` (served at `/86a0a4f9` and `/lilly-snow`)',
  '- Prevention control: `scripts/86a0a4f9-savings-audit.js` (`npm run audit:86a0a4f9`)',
  '',
  '*Treat this as a field-migration defect, not a one-line crash.* The 2026 program-year re-enrollment moved the insurance coverage classification on patient records to a new location (see `86a0a4f9-patients.js`). Every consumer of the old location is broken; only one of them crashes.',
  '',
  '*Remediation plan — once the crash is root-caused, run these three workstreams in parallel as child sessions, wait for them, then summarize in the ServiceNow incident:*',
  '1. *Blast radius in code* — find every consumer of the moved field in the service (savings-card activation AND pharmacy cost-estimate paths, telemetry included). The cost-estimate path does not crash: it silently falls back to the commercial-covered default, so Medicare Part D patients are quoted the $25 Lilly Savings Card price they are not eligible for (federal-program exclusion — an anti-kickback compliance exposure) and self-pay patients are quoted $25 instead of the LillyDirect Self Pay price. The only signal is the `cost_estimate.quoted` metric carrying `program:commercial_covered` on patients whose verified coverage is not commercial. Route all consumers through one shared resolver that fails loudly when a coverage type cannot be resolved, add regression tests for both paths, run `npm test` and `npm run lint`.',
  `2. *Blast radius in ServiceNow* — using the same Table API credentials as the incident write-back, query open incidents in assignment group "${ASSIGNMENT_GROUP}" (state < 6) that predate this incident and mention savings cards, pharmacy quotes, copays, Medicare or self-pay pricing. Decide which are the silent symptom of this same defect. For each: add a work note linking this incident and the fix PR, set \`parent_incident\` to this incident sys_id, and resolve it (\`state\` 6, \`close_code\` "Solution provided"). Report their numbers and count.`,
  '3. *Prevention* — run `npm run audit:86a0a4f9`. It resolves the savings program for every patient record through both the savings-card and cost-estimate paths and exits non-zero on any unresolved or silently reclassified coverage type; it is not wired into CI, which is why this shipped. Wire it into `npm test` (or the CI workflow) so a coverage-classification gap fails before it ships.',
  '',
  'Fold all code workstreams into a single pull request against `main`. If a child session cannot reach ServiceNow, perform workstream 2 from the parent session. Do not deploy and do not close the incident: leave it for the assignment group to review and merge. The final ServiceNow work note must state: incidents linked and resolved (numbers), routes fixed, prevention control added, PR URL.',
].join('\n');

function patientNotFound() {
  const error = new Error('Patient not found. Please verify the email address and LillyDirect patient ID.');
  error.name = 'PatientNotFoundError';
  error.statusCode = 404;
  error.code = 'PATIENT_NOT_FOUND';
  return error;
}

/**
 * Resolve the savings program that governs card eligibility from the
 * patient's insurance coverage classification.
 */
function resolveSavingsProgram(patient) {
  return PROGRAM_CONFIG[patient.coverageType];
}

/**
 * Resolve the savings program used to price a pharmacy fill. Patients whose
 * coverage classification has not been mapped are priced at the default.
 */
function resolveEstimateProgram(patient) {
  const coverageType = patient.coverageType || DEFAULT_COVERAGE;
  return { coverageType, ...PROGRAM_CONFIG[coverageType] };
}

/**
 * Synthetic card identifiers for an activated savings card.
 */
function cardIdentifiers(patient) {
  return {
    bin: '610020',
    pcn: 'PDMI',
    group: '99993163',
    memberId: `LSC${patient.id.slice(2)}`,
  };
}

/**
 * Build the savings-card activation for a patient under a savings program.
 */
function buildActivation(patient, program) {
  if (!program.savingsCardEligible) {
    return {
      eligible: false,
      status: 'Not eligible',
      programName: program.name,
      reason: program.exclusion,
    };
  }

  return {
    eligible: true,
    status: 'Active',
    programName: program.name,
    savingsCardPrice: program.savingsCardPrice,
    card: cardIdentifiers(patient),
    expiresOn: `${PROGRAM_YEAR}-12-31`,
  };
}

/**
 * What a patient pays at the pharmacy for a monthly fill under a savings program.
 */
function priceFill(program, medication) {
  if (program.savingsCardEligible) {
    const patientPays = Math.min(program.savingsCardPrice, medication.listPrice);
    return {
      patientPays,
      savingsApplied: Math.round((medication.listPrice - patientPays) * 100) / 100,
      basis: program.basis,
    };
  }

  if (program.coinsurance) {
    return {
      patientPays: Math.round(medication.listPrice * program.coinsurance * 100) / 100,
      savingsApplied: 0,
      basis: program.basis,
    };
  }

  return {
    patientPays: medication.selfPayPrice ?? medication.listPrice,
    savingsApplied: 0,
    basis: program.basis,
  };
}

/**
 * Check savings-card eligibility and activate the Lilly Savings Card for a patient.
 */
async function activateSavingsCard(data) {
  const startTime = Date.now();
  const activationId = uuidv4();
  const patient = findPatient(data);

  logger.info('Processing savings card activation', {
    activationId,
    email: data.email,
    patientId: data.patientId,
    service: SERVICE,
    route: ROUTE,
  });

  if (!patient) {
    throw patientNotFound();
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const program = resolveSavingsProgram(patient);
    const activation = buildActivation(patient, program);

    incrementMetric('savings_card.activation.success', {
      route: ROUTE,
      program: patient.benefitsVerification.coverageType,
    });
    recordTiming('savings_card.activation.latency', Date.now() - startTime, {
      route: ROUTE,
      error: 'false',
    });

    return {
      success: true,
      activationId,
      patient: patient.name,
      patientId: patient.id,
      programYear: PROGRAM_YEAR,
      payer: patient.benefitsVerification.payer,
      verifiedAt: patient.benefitsVerification.verifiedAt,
      ...activation,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('savings_card.activation.failure', {
      route: ROUTE,
      errorClass: error.name,
      patientId: patient.id,
    });
    recordTiming('savings_card.activation.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Savings card activation failed', {
      activationId,
      patientId: patient.id,
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
        alert_path: 'instant',
      },
      extra: {
        activationId,
        verifiedCoverage: patient.benefitsVerification.coverageType,
        programYear: PROGRAM_YEAR,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/86a0a4f9.js \u2014 buildActivation',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Lilly \u2014 LillyDirect Savings Card Activation',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: CUSTOMER,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'patientId', value: patient.id },
      ],
      extra: {
        activationId,
        verifiedCoverage: patient.benefitsVerification.coverageType,
        programYear: PROGRAM_YEAR,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for savings card activation error', {
        activationId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

/**
 * Estimate what a patient will pay at the pharmacy for a monthly fill.
 */
async function estimatePharmacyCost(data) {
  const startTime = Date.now();
  const estimateId = uuidv4();
  const patient = findPatient(data);
  const medication = findMedication(data.medicationId);

  logger.info('Processing pharmacy cost estimate', {
    estimateId,
    email: data.email,
    patientId: data.patientId,
    medicationId: data.medicationId,
    service: SERVICE,
    route: ESTIMATE_ROUTE,
  });

  if (!patient) {
    throw patientNotFound();
  }

  if (!medication) {
    const error = new Error(`Unknown medication: ${data.medicationId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'UNKNOWN_MEDICATION';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const program = resolveEstimateProgram(patient);
    const price = priceFill(program, medication);

    incrementMetric('cost_estimate.quoted', {
      route: ESTIMATE_ROUTE,
      program: program.coverageType,
      medicationId: medication.id,
      patientId: patient.id,
    });
    recordTiming('cost_estimate.latency', Date.now() - startTime, {
      route: ESTIMATE_ROUTE,
      error: 'false',
    });

    logger.info('Pharmacy cost estimate quoted', {
      estimateId,
      patientId: patient.id,
      program: program.coverageType,
      medicationId: medication.id,
      patientPays: price.patientPays,
    });

    return {
      success: true,
      estimateId,
      status: 'quoted',
      patient: patient.name,
      patientId: patient.id,
      programName: program.name,
      coverageType: program.coverageType,
      medication: medication.label,
      listPrice: medication.listPrice,
      patientPays: price.patientPays,
      savingsApplied: price.savingsApplied,
      savingsCardApplied: price.savingsApplied > 0,
      basis: price.basis,
      quotedAt: new Date().toISOString(),
    };
  } catch (error) {
    recordTiming('cost_estimate.latency', Date.now() - startTime, {
      route: ESTIMATE_ROUTE,
      error: 'true',
    });

    logger.error('Pharmacy cost estimate failed', {
      estimateId,
      patientId: patient.id,
      medicationId: medication.id,
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
        medicationId: medication.id,
        verifiedCoverage: patient.benefitsVerification.coverageType,
      },
    });
    throw error;
  }
}

module.exports = {
  activateSavingsCard,
  estimatePharmacyCost,
  PATIENTS,
  MEDICATIONS,
};
