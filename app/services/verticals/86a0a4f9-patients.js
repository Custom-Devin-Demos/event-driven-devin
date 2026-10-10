/**
 * Synthetic patient records, savings-program configuration and medication
 * catalog for the Lilly LillyDirect savings card & pharmacy cost vertical
 * (86a0a4f9). Every patient below is fictional demo data.
 *
 * Savings-card eligibility and pharmacy pricing are governed by the patient's
 * insurance coverage classification. The 2026 program-year re-enrollment moved
 * that classification off the patient profile and under `benefitsVerification`,
 * so the coverage type travels with the payer, verification date and source of
 * the benefits check that produced it.
 */
const PROGRAM_CONFIG = {
  commercial_covered: {
    name: 'Commercial insurance — medication covered',
    savingsCardEligible: true,
    savingsCardPrice: 25,
    basis: 'Lilly Savings Card applied — commercial plan covers this medication',
  },
  commercial_uncovered: {
    name: 'Commercial insurance — medication not covered',
    savingsCardEligible: true,
    savingsCardPrice: 499,
    basis: 'Lilly Savings Card applied — commercial plan does not cover this medication',
  },
  medicare: {
    name: 'Medicare Part D',
    savingsCardEligible: false,
    coinsurance: 0.25,
    exclusion: 'Federal health care program beneficiaries cannot use manufacturer savings cards',
    basis: 'Medicare Part D coinsurance (25%) — savings card not permitted for federal program beneficiaries',
  },
  self_pay: {
    name: 'Self pay — no insurance',
    savingsCardEligible: false,
    exclusion: 'Savings card requires commercial insurance; LillyDirect Self Pay pricing applies',
    basis: 'LillyDirect Self Pay Pharmacy price',
  },
};

const PATIENTS = [
  {
    id: 'LD70419283',
    email: 'jordan.mitchell@example.com',
    name: 'Jordan Mitchell',
    dateOfBirth: '1986-03-14',
    state: 'IN',
    prescribedMedicationId: 'zepbound-pen-5',
    benefitsVerification: {
      coverageType: 'commercial_covered',
      payer: 'Anthem Blue Cross (synthetic)',
      verifiedAt: '2026-01-06',
      source: 'eBV real-time check',
    },
  },
  {
    id: 'LD70522841',
    email: 'priya.raman@example.com',
    name: 'Priya Raman',
    dateOfBirth: '1991-08-02',
    state: 'OH',
    prescribedMedicationId: 'zepbound-pen-5',
    benefitsVerification: {
      coverageType: 'commercial_uncovered',
      payer: 'UnitedHealthcare (synthetic)',
      verifiedAt: '2026-01-09',
      source: 'eBV real-time check',
    },
  },
  {
    id: 'LD70633107',
    email: 'harold.benson@example.com',
    name: 'Harold Benson',
    dateOfBirth: '1954-11-21',
    state: 'IN',
    prescribedMedicationId: 'mounjaro-pen-5',
    benefitsVerification: {
      coverageType: 'medicare',
      payer: 'Medicare Part D — Humana (synthetic)',
      verifiedAt: '2026-01-12',
      source: 'Medicare eligibility (271)',
    },
  },
  {
    id: 'LD70748566',
    email: 'luis.ortega@example.com',
    name: 'Luis Ortega',
    dateOfBirth: '1979-05-30',
    state: 'AZ',
    prescribedMedicationId: 'zepbound-vial-5',
    benefitsVerification: {
      coverageType: 'self_pay',
      payer: 'None',
      verifiedAt: '2026-01-15',
      source: 'Patient attestation',
    },
  },
];

/**
 * Medications a patient can price at a pharmacy. `listPrice` is the monthly
 * wholesale list price; `selfPayPrice` is the LillyDirect Self Pay Pharmacy
 * price where one exists.
 */
const MEDICATIONS = [
  { id: 'zepbound-pen-5', label: 'Zepbound® 5 mg/0.5 mL single-dose pen · 4 pens', listPrice: 1086.37, selfPayPrice: null },
  { id: 'mounjaro-pen-5', label: 'Mounjaro® 5 mg/0.5 mL single-dose pen · 4 pens', listPrice: 1079.77, selfPayPrice: null },
  { id: 'zepbound-vial-5', label: 'Zepbound® 5 mg/0.5 mL single-dose vial · 4 vials', listPrice: 499.00, selfPayPrice: 499.00 },
];

function findPatient(query) {
  const email = (query.email || '').trim().toLowerCase();
  const patientId = (query.patientId || '').trim().toUpperCase();
  if (!email && !patientId) return null;
  return PATIENTS.find((p) => (!email || p.email === email) && (!patientId || p.id === patientId)) || null;
}

function findMedication(medicationId) {
  return MEDICATIONS.find((m) => m.id === medicationId) || null;
}

module.exports = {
  PROGRAM_CONFIG,
  PATIENTS,
  MEDICATIONS,
  findPatient,
  findMedication,
};
