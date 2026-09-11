/**
 * Enrolled patient records, coverage tiers and specialty therapies for the
 * Aravia Therapeutics Patient Access vertical (fcf0f903).
 *
 * Copay assistance is governed per patient by the coverage tier the patient
 * was verified into during benefits investigation. The FY26 benefits refresh
 * moved the per-patient coverage settings under `coverage` so that the plan,
 * PBM and reverification date can travel with the tier instead of living as
 * loose top-level fields.
 */
const PATIENTS = [
  {
    id: 'pat-elena-4417',
    name: 'Elena Marsh',
    dateOfBirth: '1979-03-14',
    prescriber: 'Dr. Naomi Feldstein, MD',
    coverage: {
      tier: 'commercial-specialty',
      plan: 'Meridian Health PPO',
      pbm: 'ClearScript Rx',
      reverifyBy: '2026-12-31',
    },
  },
  {
    id: 'pat-daniel-8820',
    name: 'Daniel Reyes',
    dateOfBirth: '1966-11-02',
    prescriber: 'Dr. Priya Raman, DO',
    coverage: {
      tier: 'assistance-foundation',
      plan: 'Uninsured — Aravia Cares Foundation',
      pbm: null,
      reverifyBy: '2026-09-30',
    },
  },
  {
    id: 'pat-grace-2043',
    name: 'Grace Whitfield',
    dateOfBirth: '1988-07-21',
    prescriber: 'Dr. Marcus Oyelaran, MD',
    coverage: {
      tier: 'commercial-standard',
      plan: 'Northbridge Select HMO',
      pbm: 'OptiCare PBM',
      reverifyBy: '2026-12-31',
    },
  },
];

/**
 * Copay-assistance coverage tiers. Amounts are in USD per 30-day fill.
 */
const COVERAGE_TIERS = {
  'commercial-standard': {
    label: 'Standard',
    patientCopay: 150,
    annualBenefitCap: 0,
    assistanceEligible: false,
    description: 'Commercially insured; therapy not on the plan\u2019s specialty formulary tier.',
  },
  'commercial-specialty': {
    label: 'Specialty Commercial',
    patientCopay: 10,
    annualBenefitCap: 15000,
    assistanceEligible: true,
    description: 'Commercially insured; enrolled in the Aravia Copay Savings Program.',
  },
  'assistance-foundation': {
    label: 'Foundation Assistance',
    patientCopay: 0,
    annualBenefitCap: 25000,
    assistanceEligible: true,
    description: 'Uninsured or underinsured; covered by the Aravia Cares Foundation.',
  },
};

/**
 * Specialty therapies dispensed through the Aravia patient-access hub.
 * List prices are wholesale acquisition cost per 30-day fill.
 */
const THERAPIES = [
  { id: 'thx-veltrixa', name: 'Veltrixa\u00ae (velmatinib) 200 mg tablets', indication: 'Oncology', listPrice: 14820 },
  { id: 'thx-nuvexa', name: 'Nuvexa\u00ae (nuvelimab) 150 mg/mL injection', indication: 'Immunology', listPrice: 6240 },
  { id: 'thx-corvalis', name: 'Corvalis\u00ae (corvastatide) 40 mg capsules', indication: 'Rare disease', listPrice: 21375 },
];

function findPatient(patientId) {
  return PATIENTS.find((patient) => patient.id === patientId);
}

function findTherapy(therapyId) {
  return THERAPIES.find((therapy) => therapy.id === therapyId);
}

module.exports = {
  PATIENTS,
  COVERAGE_TIERS,
  THERAPIES,
  findPatient,
  findTherapy,
};
