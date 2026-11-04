const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/e8947398/encounters/sign';
const SERVICE = 'practiceplus-charge-capture';
const SLACK_MEMBER_ID = process.env.NEXTECH_SLACK_MEMBER_ID || '';
const DATE_OF_SERVICE = '2026-11-04';
const PRACTICE = 'Lakeshore Eye Associates';

/**
 * Ophthalmology CPT codes billed from IntelleChartPRO charge capture.
 */
const CPT_CODES = {
  92014: 'Ophthalmological exam, established patient, comprehensive',
  92012: 'Ophthalmological exam, established patient, intermediate',
  92004: 'Ophthalmological exam, new patient, comprehensive',
  92083: 'Visual field exam, extended (Humphrey 24-2)',
  92133: 'OCT, optic nerve (RNFL), bilateral',
  92134: 'OCT, retina, bilateral',
  92137: 'OCT angiography (OCTA), retina, bilateral',
  92250: 'Fundus photography with interpretation',
  67028: 'Intravitreal injection of a pharmacologic agent',
  J0178: 'Aflibercept (Eylea), 1 mg',
};

/**
 * 2026 payer fee schedules imported from the clearinghouse contract load.
 * `allowed` is the contracted amount, `coinsurance` the patient share after deductible.
 */
const FEE_SCHEDULES = {
  medicare_b: {
    id: 'medicare_b', name: 'Medicare Part B (Novitas JL)', coinsurance: 0.2,
    rates: {
      92014: { allowed: 148.62 }, 92012: { allowed: 98.41 }, 92004: { allowed: 172.30 },
      92083: { allowed: 62.18 }, 92133: { allowed: 38.94 }, 92134: { allowed: 41.27 },
      92137: { allowed: 66.85 }, 92250: { allowed: 46.12 }, 67028: { allowed: 98.73 },
      J0178: { allowed: 1824.40 },
    },
  },
  humana_ma: {
    id: 'humana_ma', name: 'Humana Gold Plus (Medicare Advantage HMO)', coinsurance: 0.2,
    rates: {
      92014: { allowed: 144.10 }, 92012: { allowed: 95.36 }, 92004: { allowed: 168.02 },
      92083: { allowed: 60.04 }, 92133: { allowed: 37.80 }, 92134: { allowed: 40.11 },
      92250: { allowed: 44.79 }, 67028: { allowed: 95.88 }, J0178: { allowed: 1790.12 },
    },
  },
  aetna_ppo: {
    id: 'aetna_ppo', name: 'Aetna Open Access PPO', coinsurance: 0.1,
    rates: {
      92014: { allowed: 171.25 }, 92012: { allowed: 112.60 }, 92004: { allowed: 198.40 },
      92083: { allowed: 71.90 }, 92133: { allowed: 45.10 }, 92134: { allowed: 47.35 },
      92137: { allowed: 78.20 }, 92250: { allowed: 52.80 }, 67028: { allowed: 118.00 },
      J0178: { allowed: 1960.00 },
    },
  },
};

/**
 * Today's Check In / Out board for Dr. Priya Raman (Lakeshore Eye Associates, Chicago).
 * Encounters in "arrived" status are charted and ready to sign.
 */
const PATIENTS = {
  'NX-104582': {
    id: 'NX-104582', name: 'Harold Whitfield', gender: 'Male', dob: '1955-03-18', age: 71,
    appointment: '8:45 AM', status: 'arrived', visitType: 'Glaucoma / Diabetic Retina Follow Up',
    provider: 'Priya Raman, MD', referring: 'Mark Delgado, OD', pcp: 'Susan Park, MD', coManaged: 'Mark Delgado, OD',
    payer: 'humana_ma', memberId: 'H5216-4471-02', balance: 0, copay: 0,
    chiefComplaint: 'Blurry vision OD, worse at night. "Halos around lights."',
    hpi: 'Pt reports gradual blur OD x 3 months. Compliant with latanoprost QHS OU. A1c 7.8 (Sept).',
    va: { od: '20/50', os: '20/25' }, iop: { od: 21, os: 17 },
    exam: [
      { label: 'Pupils', od: 'Round, Brisk, No RAPD', os: 'Round, Brisk, No RAPD' },
      { label: 'Lens', od: '2+ Nuclear Sclerosis', os: '1+ Nuclear Sclerosis' },
      { label: 'Optic Nerve', od: 'C/D 0.75, inferior thinning', os: 'C/D 0.60' },
      { label: 'Macula', od: 'Scattered dot-blot hemes, no CSME', os: 'Few microaneurysms' },
    ],
    problems: [
      { icd10: 'H40.1132', text: 'Primary open-angle glaucoma, bilateral, moderate stage' },
      { icd10: 'E11.3293', text: 'Type 2 diabetes w/ mild NPDR without macular edema, bilateral' },
      { icd10: 'H25.13', text: 'Age-related nuclear cataract, bilateral' },
    ],
    measures: ['MIPS #12 \u2014 POAG optic nerve evaluation', 'MIPS #117 \u2014 Diabetes: eye exam', 'MIPS #130 \u2014 Current medications documented', 'MIPS #191 \u2014 Cataracts: 20/40 VA within 90 days'],
    plan: 'Continue latanoprost OU. Add OCTA to rule out NV given new hemes. RTC 3 months with HVF 24-2.',
    charges: [
      { cpt: '92014', modifier: '25', dx: 'H40.1132' },
      { cpt: '92133', modifier: '', dx: 'H40.1132' },
      { cpt: '92137', modifier: '', dx: 'E11.3293' },
    ],
    iopHistory: [
      { date: '2025-05-12', od: 26, os: 21 }, { date: '2025-08-14', od: 22, os: 18 },
      { date: '2025-11-20', od: 20, os: 17 }, { date: '2026-02-19', od: 19, os: 16 },
      { date: '2026-05-21', od: 20, os: 17 }, { date: '2026-08-13', od: 19, os: 16 },
      { date: '2026-11-04', od: 21, os: 17 },
    ],
  },
  'NX-104611': {
    id: 'NX-104611', name: 'Maria Santos', gender: 'Female', dob: '1949-09-02', age: 77,
    appointment: '9:00 AM', status: 'arrived', visitType: 'Wet AMD Injection',
    provider: 'Priya Raman, MD', referring: 'Self', pcp: 'James Okafor, MD', coManaged: '\u2014',
    payer: 'medicare_b', memberId: '1EG4-TE5-MK72', balance: 214.60, copay: 0,
    chiefComplaint: 'Scheduled Eylea injection OS.',
    hpi: 'Neovascular AMD OS, q8wk aflibercept. Stable vision, no new distortion on Amsler.',
    va: { od: '20/30', os: '20/60' }, iop: { od: 15, os: 16 },
    exam: [
      { label: 'Pupils', od: 'Round, Brisk', os: 'Round, Brisk' },
      { label: 'Lens', od: 'PCIOL', os: 'PCIOL' },
      { label: 'Macula', od: 'Drusen and RPE changes', os: 'Trace SRF, improved from last visit' },
    ],
    problems: [
      { icd10: 'H35.3221', text: 'Exudative AMD, left eye, with active CNV' },
      { icd10: 'Z96.1', text: 'Pseudophakia, bilateral' },
    ],
    measures: ['MIPS #14 \u2014 AMD: dilated macular examination', 'MIPS #130 \u2014 Current medications documented'],
    plan: 'Intravitreal aflibercept 2 mg OS today. Extend to q10wk if dry at next visit.',
    charges: [
      { cpt: '92134', modifier: '', dx: 'H35.3221' },
      { cpt: '67028', modifier: 'LT', dx: 'H35.3221' },
      { cpt: 'J0178', modifier: '', dx: 'H35.3221', units: 2 },
    ],
    iopHistory: [
      { date: '2026-05-06', od: 15, os: 17 }, { date: '2026-07-01', od: 14, os: 16 },
      { date: '2026-09-02', od: 15, os: 15 }, { date: '2026-11-04', od: 15, os: 16 },
    ],
  },
  'NX-104655': {
    id: 'NX-104655', name: 'Daniel Brooks', gender: 'Male', dob: '1981-06-27', age: 45,
    appointment: '9:15 AM', status: 'arrived', visitType: 'Glaucoma Suspect',
    provider: 'Priya Raman, MD', referring: 'Lena Hoffman, OD', pcp: 'Rachel Kim, MD', coManaged: '\u2014',
    payer: 'aetna_ppo', memberId: 'W288194017', balance: 0, copay: 40,
    chiefComplaint: 'Referred for elevated IOP at routine exam.',
    hpi: 'Family hx glaucoma (father). No ocular meds. Last eye exam 2 yrs ago.',
    va: { od: '20/20', os: '20/20' }, iop: { od: 23, os: 22 },
    exam: [
      { label: 'Pupils', od: 'Round, Brisk, No RAPD', os: 'Round, Brisk, No RAPD' },
      { label: 'Gonio', od: 'Open to CB 360', os: 'Open to CB 360' },
      { label: 'Optic Nerve', od: 'C/D 0.55', os: 'C/D 0.50' },
    ],
    problems: [{ icd10: 'H40.013', text: 'Open angle with borderline findings, low risk, bilateral' }],
    measures: ['MIPS #130 \u2014 Current medications documented', 'MIPS #226 \u2014 Tobacco use screening'],
    plan: 'Baseline HVF 24-2 and RNFL OCT. Observe, RTC 6 months.',
    charges: [
      { cpt: '92004', modifier: '', dx: 'H40.013' },
      { cpt: '92083', modifier: '', dx: 'H40.013' },
      { cpt: '92133', modifier: '', dx: 'H40.013' },
    ],
    iopHistory: [{ date: '2026-10-08', od: 24, os: 23 }, { date: '2026-11-04', od: 23, os: 22 }],
  },
};

const BOARD = {
  confirmed: [
    { time: '9:30 AM', name: 'Evelyn Carter', visitType: 'Post-Op Day 1 (Cataract OD)' },
    { time: '9:45 AM', name: 'Robert Nguyen', visitType: 'Dry Eye Follow Up' },
    { time: '10:00 AM', name: 'Linda Morales', visitType: 'Diabetic Eye Exam' },
    { time: '10:15 AM', name: 'Thomas Reed', visitType: 'Cataract Consult' },
    { time: '10:30 AM', name: 'Grace Liu', visitType: 'YAG Capsulotomy Eval' },
  ],
  completed: [
    { time: '7:45 AM', name: 'Rebecca Jackson', visitType: 'IOP Check' },
    { time: '8:00 AM', name: 'Yuri Johnson', visitType: 'Post-Op Week 1' },
    { time: '8:15 AM', name: 'Sue Price', visitType: 'Annual Exam' },
    { time: '8:30 AM', name: 'Faith Reding', visitType: 'Retina Follow Up' },
  ],
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

function summarize(p) {
  return {
    id: p.id, name: p.name, gender: p.gender, dob: p.dob, age: p.age, appointment: p.appointment,
    status: p.status, visitType: p.visitType, provider: p.provider, referring: p.referring, pcp: p.pcp,
    coManaged: p.coManaged, payer: p.payer, payerName: FEE_SCHEDULES[p.payer].name, memberId: p.memberId,
    balance: p.balance, copay: p.copay,
  };
}

function getSchedule() {
  return {
    practice: PRACTICE,
    dateOfService: DATE_OF_SERVICE,
    provider: 'Priya Raman, MD',
    arrived: Object.values(PATIENTS).map(summarize),
    confirmed: BOARD.confirmed,
    completed: BOARD.completed,
  };
}

function getChart(patientId) {
  const p = PATIENTS[patientId];
  return {
    ...summarize(p),
    chiefComplaint: p.chiefComplaint, hpi: p.hpi, va: p.va, iop: p.iop, exam: p.exam,
    problems: p.problems, measures: p.measures, plan: p.plan, iopHistory: p.iopHistory,
    charges: p.charges.map((c) => ({ ...c, units: c.units || 1, description: CPT_CODES[c.cpt] })),
  };
}

/**
 * Prices one charge line against the patient's payer fee schedule.
 */
function priceCharge(charge, schedule) {
  const units = charge.units || 1;
  const allowed = schedule.rates[charge.cpt].allowed * units;
  return {
    cpt: charge.cpt, modifier: charge.modifier, dx: charge.dx, units,
    description: CPT_CODES[charge.cpt],
    allowed: round2(allowed),
    patientResponsibility: round2(allowed * schedule.coinsurance),
  };
}

/**
 * Signs the IntelleChartPRO encounter and posts its charges to Practice+ billing,
 * computing expected reimbursement and patient responsibility for checkout.
 */
async function signEncounter(data) {
  const startTime = Date.now();
  const patient = PATIENTS[data.patientId];
  const schedule = FEE_SCHEDULES[patient.payer];
  const encounterRef = `ENC-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestId = data.requestId || uuidv4();

  logger.info('Signing IntelleChartPRO encounter and posting charges', {
    encounterRef, requestId, patientId: patient.id, payer: patient.payer, charges: patient.charges.length,
    dateOfService: DATE_OF_SERVICE, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 400));

    const lines = patient.charges.map((c) => priceCharge(c, schedule));
    const totals = lines.reduce((acc, l) => ({
      allowed: acc.allowed + l.allowed, patient: acc.patient + l.patientResponsibility,
    }), { allowed: 0, patient: 0 });
    const patientShare = Math.min(totals.patient + patient.copay, totals.allowed);

    incrementMetric('encounter.sign.success', { route: ROUTE, payer: patient.payer });
    recordTiming('encounter.sign.latency', Date.now() - startTime, { route: ROUTE });

    return {
      success: true,
      encounterRef,
      patientId: patient.id,
      patientName: patient.name,
      dateOfService: DATE_OF_SERVICE,
      payer: schedule.name,
      lines,
      expectedReimbursement: round2(totals.allowed - patientShare),
      patientResponsibility: round2(patientShare),
      claimStatus: 'Queued for scrubber',
      signedBy: patient.provider,
      signedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('encounter.sign.failure', { route: ROUTE, errorClass: error.name, payer: patient.payer });
    recordTiming('encounter.sign.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('IntelleChartPRO encounter sign / charge posting failed', {
      encounterRef, requestId, patientId: patient.id, payer: patient.payer, error: error.message,
      errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'intellechart-charge-capture', alert_path: 'instant' },
      extra: { encounterRef, patientId: patient.id, payer: patient.payer, cpts: patient.charges.map((c) => c.cpt) },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e8947398.js \u2014 priceCharge',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'e8947398',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Nextech IntelleChartPRO \u2014 Sign & Post Charges',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'payer', value: patient.payer },
        { key: 'cpt_codes', value: patient.charges.map((c) => c.cpt).join(',') },
      ],
      extra: { encounterRef, patientId: patient.id, practice: PRACTICE, dateOfService: DATE_OF_SERVICE },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.1`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Nextech charge capture error', { error: err.message });
    });

    error.encounterRef = encounterRef;
    throw error;
  }
}

module.exports = {
  signEncounter,
  getSchedule,
  getChart,
  priceCharge,
  PATIENTS,
  FEE_SCHEDULES,
  CPT_CODES,
};
