const logger = require('../app/telemetry/logger');
const { PATIENTS, PROGRAM_CONFIG } = require('../app/services/verticals/86a0a4f9-patients');

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

const { activateSavingsCard, estimatePharmacyCost } = require('../app/services/verticals/86a0a4f9');

function verifiedCoverage(patient) {
  return patient.benefitsVerification.coverageType;
}

function row(patient, path, status, effective, detail) {
  return {
    patient: patient.id,
    path,
    status,
    expected: verifiedCoverage(patient),
    effective,
    detail,
  };
}

async function auditPath(patient, path) {
  const expected = PROGRAM_CONFIG[verifiedCoverage(patient)];

  try {
    if (path === 'savings-card') {
      const result = await activateSavingsCard({ email: patient.email, patientId: patient.id });
      if (result.programName !== expected.name || result.eligible !== expected.savingsCardEligible) {
        return row(patient, path, 'reclassified', result.programName, 'activation decided under a program the patient is not verified for');
      }
      return row(patient, path, 'ok', verifiedCoverage(patient), 'probe completed');
    }

    const result = await estimatePharmacyCost({ patientId: patient.id, medicationId: patient.prescribedMedicationId });
    if (result.coverageType !== verifiedCoverage(patient)) {
      return row(patient, path, 'reclassified', result.coverageType, 'quoted under a coverage type the patient is not verified for');
    }
    return row(patient, path, 'ok', result.coverageType, 'probe completed');
  } catch (error) {
    return row(patient, path, 'unresolved', '-', `${error.name || 'Error'}: ${error.message}`);
  }
}

async function auditPatients() {
  const results = [];
  for (const patient of PATIENTS) {
    results.push(await auditPath(patient, 'savings-card'));
    results.push(await auditPath(patient, 'cost-estimate'));
  }
  return results;
}

function render(results) {
  const headers = ['Patient', 'Path', 'Status', 'Verified', 'Effective', 'Detail'];
  const lines = [
    'LillyDirect savings program audit',
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
    process.stderr.write(`LillyDirect savings program audit failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  auditPatients,
  auditPath,
  render,
  main,
};
