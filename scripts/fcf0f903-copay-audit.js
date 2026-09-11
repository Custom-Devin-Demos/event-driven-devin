const logger = require('../app/telemetry/logger');
const {
  PATIENTS,
  COVERAGE_TIERS,
} = require('../app/services/verticals/fcf0f903-patients');

const THERAPY_ID = 'thx-veltrixa';

function installOfflineStubs() {
  const devinSessionPath = require.resolve('../app/services/devin-session');
  require.cache[devinSessionPath] = {
    id: devinSessionPath,
    filename: devinSessionPath,
    loaded: true,
    exports: {
      createSessionAndAlert: () => Promise.resolve({ triggered: false }),
    },
  };

  const { Sentry } = require('../app/telemetry/sentry');
  Sentry.captureException = () => undefined;
}

installOfflineStubs();

const { submitEnrollment, estimateCopay } = require('../app/services/verticals/fcf0f903');

function serviceData(patient) {
  return {
    patientId: patient.id,
    therapyId: THERAPY_ID,
    consent: true,
    fills: 1,
  };
}

function expectedBenefit(patient) {
  return COVERAGE_TIERS[patient.coverage.tier];
}

function row(patient, path, status, expected, effective, detail) {
  return {
    patient: patient.id,
    path,
    status,
    expected,
    effective,
    detail,
  };
}

async function auditPath(patient, path) {
  const expected = expectedBenefit(patient);
  const fn = path === 'enrollment' ? submitEnrollment : estimateCopay;

  try {
    const result = await fn(serviceData(patient));
    if (result.tier !== expected.label) {
      return row(patient, path, 'downgraded', expected.label, result.tier, 'effective tier differs');
    }
    if (result.patientCopay !== expected.patientCopay) {
      return row(
        patient,
        path,
        'downgraded',
        expected.label,
        `$${result.patientCopay}`,
        'effective copay differs',
      );
    }
    return row(patient, path, 'ok', expected.label, result.tier, 'probe completed');
  } catch (error) {
    if (path === 'enrollment' && error.name === 'EligibilityError') {
      if (expected.assistanceEligible) {
        return row(patient, path, 'downgraded', expected.label, 'Standard', 'declined for assistance');
      }
      return row(patient, path, 'ok', expected.label, expected.label, 'declined as expected');
    }

    const detail = `${error.name || 'Error'}: ${error.message}`;
    return row(patient, path, 'unresolved', expected.label, '-', detail);
  }
}

async function auditPatients() {
  const results = [];
  for (const patient of PATIENTS) {
    results.push(await auditPath(patient, 'enrollment'));
    results.push(await auditPath(patient, 'estimate'));
  }
  return results;
}

function render(results) {
  const headers = ['Patient', 'Path', 'Status', 'Expected', 'Effective', 'Detail'];
  const lines = [
    'Patient Access coverage-tier audit',
    '',
    headers.join(' | '),
    headers.map(() => '---').join(' | '),
    ...results.map((result) => [
      result.patient,
      result.path,
      result.status,
      result.expected,
      result.effective,
      result.detail,
    ].join(' | ')),
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  logger.silent = true;
  const results = await auditPatients();
  process.stdout.write(render(results));
  if (results.some((result) => result.status !== 'ok')) {
    process.exitCode = 1;
  }
  return results;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Patient Access coverage-tier audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  auditPatients,
  auditPath,
  render,
};
