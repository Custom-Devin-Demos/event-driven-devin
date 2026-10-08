const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/f6f40dd7/payer-rules/run';
const SERVICE = 'customer-f6f40dd7-complex-claims';
const CLIENT = { id: 'CRH', name: 'Cumberland Regional Health', state: 'TN', facilities: 4 };
const SLACK_MEMBER_ID = process.env.ENABLECOMP_SLACK_MEMBER_ID || 'U0B7F46NVA4';
const AVG_DAYS_TO_PAYMENT = 47;

const CATEGORIES = {
  va: { label: 'Veterans Affairs', short: 'VA' },
  wc: { label: "Workers' Compensation", short: 'WC' },
  mva: { label: 'Motor Vehicle Accident', short: 'MVA' },
  oos: { label: 'Out-of-State Medicaid', short: 'OOS Medicaid' },
};

// Allowed-amount factors applied on top of the charge master (illustrative fee schedules).
const FEE_SCHEDULES = {
  mva: { TN: { label: 'TN PIP / med-pay (UCR 80th percentile)', factor: 0.65 }, KY: { label: 'KY PIP fee schedule', factor: 0.62 }, GA: { label: 'GA med-pay UCR', factor: 0.66 } },
  wc: { TN: { label: 'TN Bureau of Workers’ Compensation Medical Fee Schedule (2026)', factor: 0.77 } },
  va: { ALL: { label: 'VA Community Care Network — Medicare-based rate', factor: 0.705 } },
  oos: { KY: { label: 'Kentucky Medicaid out-of-state provider rate', factor: 0.54 }, GA: { label: 'Georgia Medicaid border-provider rate', factor: 0.54 } },
};

const SEED_CLAIMS = [
  {
    accountId: 'CRH-4471023', patient: 'J.M.', category: 'mva', payer: 'State Farm Mutual Automobile Ins.', facility: 'Cumberland Regional Medical Center', state: 'TN',
    dos: '2026-08-14', billed: 48230.0, expected: 31349.5, status: 'ready', encounter: 'Inpatient — orthopedic trauma, 3-day stay',
    facts: { accidentType: 'Two-vehicle collision, patient was driver', policeReport: 'Metro Nashville PD #2026-0814-3317', patientCoverage: 'BCBS TN (health) — MVA exclusion, liability primary', attorney: 'None on file', eligibilityVerifiedOn: '2026-08-15' },
    intake: { carrierOnFile: 'State Farm Mutual Automobile Ins.', policyNumberOnFile: 'SF-TN-88214907', carrierClaimNumber: '55-2231-K84' },
    documents: [
      { kind: 'accident-report', title: 'Metro Nashville PD Crash Report #2026-0814-3317', source: 'scanned', sourceLabel: 'Scanned PDF · OCR', pages: 4, receivedOn: '2026-08-21', ocr: { confidence: 0.81, fields: { report_number: '2026-0814-3317', crash_state: 'TN', vehicles: '2', at_fault_party: 'Other driver' } } },
      { kind: 'face-sheet', title: 'Registration face sheet', source: 'ehr', sourceLabel: 'EHR feed', pages: 2, receivedOn: '2026-08-14' },
      { kind: 'ub04', title: 'UB-04 claim form (final bill)', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-08-19' },
      { kind: 'medical-records', title: 'Operative report + discharge summary', source: 'ehr', sourceLabel: 'EHR feed', pages: 17, receivedOn: '2026-08-19' },
    ],
  },
  {
    accountId: 'CRH-4468817', patient: 'R.T.', category: 'wc', payer: 'Travelers Indemnity Co.', facility: 'Cumberland Regional Medical Center', state: 'TN',
    dos: '2026-09-02', billed: 12480.0, expected: 9609.6, status: 'ready', encounter: 'Emergency — laceration repair, hand',
    facts: { employer: 'Harpeth Logistics LLC', injuryDescription: 'Laceration to left hand during loading', firstReportOfInjury: 'C-20 filed 2026-09-03', adjuster: 'K. Delgado · Travelers', eligibilityVerifiedOn: '2026-09-03' },
    documents: [
      { kind: 'froi', title: 'TN Form C-20 First Report of Work Injury', source: 'portal', sourceLabel: 'Employer portal', pages: 2, receivedOn: '2026-09-03' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-09-04' },
      { kind: 'medical-records', title: 'ED record + wound care notes', source: 'ehr', sourceLabel: 'EHR feed', pages: 6, receivedOn: '2026-09-04' },
    ],
  },
  {
    accountId: 'CRH-4452190', patient: 'L.K.', category: 'va', payer: 'VA Community Care Network — Optum (Region 3)', facility: 'Cumberland Regional Medical Center', state: 'TN',
    dos: '2026-07-29', billed: 86900.0, expected: 61264.5, status: 'ready', encounter: 'Inpatient — cardiac catheterization',
    facts: { referralNumber: 'VA0012398774', authorizationWindow: '2026-07-20 → 2026-10-18', vamc: 'Tennessee Valley Healthcare System', seoc: 'Cardiology — Interventional', eligibilityVerifiedOn: '2026-07-29' },
    documents: [
      { kind: 'referral', title: 'VA referral / authorization (SEOC)', source: 'portal', sourceLabel: 'HSRM portal', pages: 3, receivedOn: '2026-07-28' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-08-02' },
      { kind: 'medical-records', title: 'Cath lab report + discharge summary', source: 'ehr', sourceLabel: 'EHR feed', pages: 22, receivedOn: '2026-08-02' },
    ],
  },
  {
    accountId: 'CRH-4479331', patient: 'D.P.', category: 'oos', payer: 'Kentucky Medicaid — Anthem BCBS Medicaid KY', facility: 'Cumberland Regional — Clarksville', state: 'KY',
    dos: '2026-09-11', billed: 9740.0, expected: 5259.6, status: 'ready', encounter: 'Emergency — observation, chest pain',
    facts: { memberState: 'KY', memberId: 'KY7731902845', enrollmentStatus: 'Active — Anthem KY Medicaid MCO', providerEnrollment: 'KY out-of-state enrollment approved 2024-11', eligibilityVerifiedOn: '2026-09-12' },
    documents: [
      { kind: 'eligibility', title: 'KY MMIS eligibility response (270/271)', source: 'portal', sourceLabel: 'Payer portal', pages: 1, receivedOn: '2026-09-12' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-09-13' },
    ],
  },
  {
    accountId: 'CRH-4463755', patient: 'A.S.', category: 'mva', payer: 'GEICO General Insurance Co.', facility: 'Cumberland Regional — Hendersonville', state: 'TN',
    dos: '2026-08-28', billed: 23110.0, expected: 15021.5, status: 'ready', encounter: 'Emergency — CT head/cervical, closed fracture',
    facts: { accidentType: 'Rear-end collision, patient was passenger', policeReport: 'THP eCrash #TN26-088-10422', patientCoverage: 'Self-pay (health) — liability primary', attorney: 'Bart Durham Injury Law (LOP on file)', eligibilityVerifiedOn: '2026-08-29' },
    intake: { carrierOnFile: 'GEICO General Insurance Co.', policyNumberOnFile: 'GC-4471-220-19', carrierClaimNumber: '0712334890101' },
    documents: [
      { kind: 'accident-report', title: 'THP Electronic Crash Report #TN26-088-10422', source: 'ecrash', sourceLabel: 'TN eCrash feed', pages: 3, receivedOn: '2026-08-29', data: { crashDate: '2026-08-28', state: 'TN', reportNumber: 'TN26-088-10422', liabilityCarrier: { name: 'GEICO General Insurance Co.', policyNumber: 'GC-4471-220-19', claimNumber: '0712334890101', adjuster: 'M. Okafor' } } },
      { kind: 'lop', title: 'Letter of protection — Bart Durham Injury Law', source: 'portal', sourceLabel: 'Attorney portal', pages: 1, receivedOn: '2026-09-02' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-08-31' },
    ],
  },
  {
    accountId: 'CRH-4458402', patient: 'M.W.', category: 'wc', payer: 'Liberty Mutual Insurance', facility: 'Cumberland Regional Medical Center', state: 'TN',
    dos: '2026-08-05', billed: 31275.0, expected: 24081.75, status: 'ready', encounter: 'Outpatient surgery — rotator cuff repair',
    facts: { employer: 'Nashville Steel Fabricators', injuryDescription: 'Shoulder injury lifting beam', firstReportOfInjury: 'C-20 filed 2026-08-06', adjuster: 'P. Lindqvist · Liberty Mutual', eligibilityVerifiedOn: '2026-08-06' },
    documents: [
      { kind: 'froi', title: 'TN Form C-20 First Report of Work Injury', source: 'portal', sourceLabel: 'Employer portal', pages: 2, receivedOn: '2026-08-06' },
      { kind: 'auth', title: 'Utilization review approval — arthroscopy', source: 'portal', sourceLabel: 'Carrier portal', pages: 1, receivedOn: '2026-08-01' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-08-08' },
    ],
  },
  {
    accountId: 'CRH-4482006', patient: 'C.B.', category: 'va', payer: 'VA Community Care Network — Optum (Region 3)', facility: 'Cumberland Regional — Hendersonville', state: 'TN',
    dos: '2026-09-19', billed: 4120.0, expected: 2904.6, status: 'ready', encounter: 'Outpatient — MRI lumbar spine',
    facts: { referralNumber: 'VA0012421188', authorizationWindow: '2026-09-10 → 2026-12-09', vamc: 'Tennessee Valley Healthcare System', seoc: 'Diagnostic imaging', eligibilityVerifiedOn: '2026-09-19' },
    documents: [
      { kind: 'referral', title: 'VA referral / authorization (SEOC)', source: 'portal', sourceLabel: 'HSRM portal', pages: 2, receivedOn: '2026-09-15' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-09-21' },
    ],
  },
  {
    accountId: 'CRH-4449918', patient: 'E.H.', category: 'oos', payer: 'Georgia Medicaid — Peach State Health Plan', facility: 'Cumberland Regional Medical Center', state: 'GA',
    dos: '2026-07-16', billed: 18660.0, expected: 10076.4, status: 'rules_complete', encounter: 'Inpatient — pneumonia, 2-day stay',
    facts: { memberState: 'GA', memberId: 'GA110229384', enrollmentStatus: 'Active — Peach State (Centene)', providerEnrollment: 'GA out-of-state enrollment approved 2025-03', eligibilityVerifiedOn: '2026-07-17' },
    documents: [
      { kind: 'eligibility', title: 'GAMMIS eligibility response (270/271)', source: 'portal', sourceLabel: 'Payer portal', pages: 1, receivedOn: '2026-07-17' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-07-20' },
    ],
  },
  {
    accountId: 'CRH-4475560', patient: 'S.N.', category: 'mva', payer: 'Progressive Casualty Insurance Co.', facility: 'Cumberland Regional — Clarksville', state: 'TN',
    dos: '2026-09-06', billed: 7980.0, expected: 5187.0, status: 'ready', encounter: 'Emergency — X-ray, soft tissue',
    facts: { accidentType: 'Side-impact collision, patient was driver', policeReport: 'Clarksville PD eCrash #CPD26-2490', patientCoverage: 'Cigna (health) — liability primary', attorney: 'None on file', eligibilityVerifiedOn: '2026-09-08' },
    intake: { carrierOnFile: 'Progressive Casualty Insurance Co.', policyNumberOnFile: 'PRG-930112-7', carrierClaimNumber: '26-5581204' },
    documents: [
      { kind: 'accident-report', title: 'Clarksville PD Electronic Crash Report #CPD26-2490', source: 'ecrash', sourceLabel: 'TN eCrash feed', pages: 3, receivedOn: '2026-09-08', data: { crashDate: '2026-09-06', state: 'TN', reportNumber: 'CPD26-2490', liabilityCarrier: { name: 'Progressive Casualty Insurance Co.', policyNumber: 'PRG-930112-7', claimNumber: '26-5581204', adjuster: 'J. Tran' } } },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-09-09' },
    ],
  },
  {
    accountId: 'CRH-4461284', patient: 'T.G.', category: 'wc', payer: 'Zurich American Insurance Co.', facility: 'Cumberland Regional Medical Center', state: 'TN',
    dos: '2026-08-21', billed: 56400.0, expected: 43428.0, status: 'submitted', encounter: 'Inpatient — crush injury, 4-day stay',
    facts: { employer: 'Mid-South Rail Services', injuryDescription: 'Crush injury, right foot', firstReportOfInjury: 'C-20 filed 2026-08-22', adjuster: 'A. Whitfield · Zurich', eligibilityVerifiedOn: '2026-08-22' },
    submission: { submittedAt: '2026-09-30T14:12:00.000Z', confirmation: 'ZUR-26-0930-71884', projectedReimbursement: 43428.0 },
    documents: [
      { kind: 'froi', title: 'TN Form C-20 First Report of Work Injury', source: 'portal', sourceLabel: 'Employer portal', pages: 2, receivedOn: '2026-08-22' },
      { kind: 'ub04', title: 'UB-04 claim form', source: 'ehr', sourceLabel: 'EHR feed', pages: 1, receivedOn: '2026-08-27' },
    ],
  },
];

const REMEDIATION_DIRECTIVE = `
## Remediation directive (EnableComp e360 RCM — Complex Claims payer rules)
- The failing request is POST ${ROUTE} for account CRH-4471023, a Motor Vehicle Accident claim whose police report arrived as a scanned PDF (source "scanned") and was OCR'd with the accident date and liability-carrier fields missing.
- Trace how the accident record is built from the claim's documents in app/services/verticals/f6f40dd7.js (\`normalizeAccidentRecord\`) and how the COB rule consumes it (\`determineCobOrder\`), then fix the root cause so scanned reports with incomplete OCR still produce a complete accident record — the account already carries the carrier, policy number and carrier claim number from registration (\`claim.intake\`).
- Keep the eCrash (electronic report) path and every VA, Workers' Compensation and Out-of-State Medicaid rule behaving exactly as they do today.
- Add a regression test in tests/f6f40dd7-complex-claims.test.js that runs payer rules on CRH-4471023 and expects a completed rule set with a projected reimbursement, and one that keeps CRH-4463755 (eCrash report) passing.
`;

class ClaimError extends Error {
  constructor(message, code, statusCode) {
    super(message);
    this.name = 'ClaimError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const claimState = new Map();

function resetState() {
  claimState.clear();
  SEED_CLAIMS.forEach((claim) => {
    claimState.set(claim.accountId, {
      ...claim,
      rules: claim.status === 'rules_complete' ? completedRuleSetFor(claim) : null,
      projectedReimbursement: claim.status === 'rules_complete' ? claim.expected : (claim.submission ? claim.submission.projectedReimbursement : null),
    });
  });
}

function daysSince(isoDate, now = Date.now()) {
  return Math.max(0, Math.round((now - new Date(`${isoDate}T12:00:00Z`).getTime()) / 86400000));
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function pass(rule, label, detail) {
  return { rule, label, status: 'pass', detail };
}

// Builds the single accident record the MVA rules consume from the claim's source documents.
// Electronic crash reports arrive structured; scanned police reports arrive as OCR field extractions.
function normalizeAccidentRecord(claim) {
  const report = claim.documents.find((doc) => doc.kind === 'accident-report');
  if (!report) return null;

  if (report.source === 'ecrash') {
    return {
      accidentDate: report.data.crashDate,
      state: report.data.state,
      reportNumber: report.data.reportNumber,
      liabilityCarrier: { ...report.data.liabilityCarrier },
      source: report.sourceLabel,
    };
  }

  const fields = (report.ocr && report.ocr.fields) || {};
  return {
    accidentDate: fields.accident_date,
    state: fields.crash_state,
    reportNumber: fields.report_number,
    liabilityCarrier: fields.carrier_name
      ? { name: fields.carrier_name, policyNumber: fields.policy_number, claimNumber: fields.carrier_claim_number, adjuster: fields.adjuster }
      : undefined,
    source: `${report.sourceLabel} ${Math.round(report.ocr.confidence * 100)}%`,
  };
}

function verifyEligibility(claim) {
  const verifiedOn = claim.facts.eligibilityVerifiedOn;
  if (!verifiedOn) throw new ClaimError(`Eligibility has not been verified for ${claim.accountId}.`, 'ELIGIBILITY_UNVERIFIED', 409);
  const detailByCategory = {
    va: `${claim.facts.referralNumber} active · ${claim.facts.authorizationWindow}`,
    wc: `${claim.facts.firstReportOfInjury} · employer ${claim.facts.employer}`,
    mva: `${claim.facts.patientCoverage}`,
    oos: `${claim.facts.enrollmentStatus} · member ${claim.facts.memberId}`,
  };
  return pass('eligibility', 'Eligibility verified', `${detailByCategory[claim.category]} (verified ${verifiedOn})`);
}

function identifyResponsiblePayer(claim, accident) {
  if (claim.category === 'mva') {
    const reportRef = accident && accident.reportNumber ? ` · report #${accident.reportNumber}` : '';
    return pass('carrier', 'Liability carrier identified', `${claim.payer}${reportRef}`);
  }
  if (claim.category === 'wc') return pass('carrier', 'Workers’ comp carrier identified', `${claim.payer} · adjuster ${claim.facts.adjuster}`);
  if (claim.category === 'va') return pass('carrier', 'Third-party administrator identified', `${claim.payer} · ${claim.facts.vamc}`);
  return pass('carrier', 'Out-of-state Medicaid MCO identified', `${claim.payer} · ${claim.facts.providerEnrollment}`);
}

function applyFeeSchedule(claim) {
  const table = FEE_SCHEDULES[claim.category];
  const schedule = table[claim.state] || table.ALL;
  if (!schedule) throw new ClaimError(`No ${CATEGORIES[claim.category].label} fee schedule is configured for ${claim.state}.`, 'FEE_SCHEDULE_MISSING', 422);
  const allowed = round2(claim.billed * schedule.factor);
  return { ...pass('fee-schedule', 'Fee schedule applied', `${schedule.label} · allowed $${allowed.toLocaleString('en-US', { minimumFractionDigits: 2 })}`), allowed };
}

function determineCobOrder(claim, accident) {
  if (claim.category === 'mva') {
    const policyNumber = accident.liabilityCarrier.policyNumber;
    const order = [
      { position: 1, payer: accident.liabilityCarrier.name, reference: policyNumber, basis: 'Third-party liability (at-fault carrier)' },
      { position: 2, payer: claim.facts.patientCoverage.split(' — ')[0], reference: 'Patient health plan', basis: 'Secondary after liability settlement' },
    ];
    return { ...pass('cob', 'COB order determined', `1. ${order[0].payer} (${policyNumber}) → 2. ${order[1].payer}`), order };
  }
  if (claim.category === 'wc') {
    const order = [{ position: 1, payer: claim.payer, reference: claim.facts.firstReportOfInjury, basis: 'Workers’ compensation is sole payer; health plan excluded' }];
    return { ...pass('cob', 'COB order determined', `1. ${claim.payer} (sole payer — health plan excluded)`), order };
  }
  if (claim.category === 'va') {
    const order = [{ position: 1, payer: claim.payer, reference: claim.facts.referralNumber, basis: 'VA authorized community care; no patient liability' }];
    return { ...pass('cob', 'COB order determined', `1. ${claim.payer} (authorized care, $0 patient liability)`), order };
  }
  const order = [{ position: 1, payer: claim.payer, reference: claim.facts.memberId, basis: 'Medicaid is payer of last resort; no other coverage on file' }];
  return { ...pass('cob', 'COB order determined', `1. ${claim.payer} (payer of last resort)`), order };
}

function projectReimbursement(claim, feeSchedule) {
  const expected = round2(Math.min(feeSchedule.allowed, claim.expected));
  return { ...pass('projection', 'Reimbursement projected', `$${expected.toLocaleString('en-US', { minimumFractionDigits: 2 })} expected · ~${AVG_DAYS_TO_PAYMENT} days to payment`), expected };
}

function completedRuleSetFor(claim) {
  const accident = normalizeAccidentRecord(claim);
  const feeSchedule = applyFeeSchedule(claim);
  return [verifyEligibility(claim), identifyResponsiblePayer(claim, accident), feeSchedule, determineCobOrder(claim, accident), projectReimbursement(claim, feeSchedule)];
}

function evaluatePayerRules(claim, completed) {
  const accident = normalizeAccidentRecord(claim);
  completed.push(verifyEligibility(claim));
  completed.push(identifyResponsiblePayer(claim, accident));
  const feeSchedule = applyFeeSchedule(claim);
  completed.push(feeSchedule);
  const cob = determineCobOrder(claim, accident);
  completed.push(cob);
  const projection = projectReimbursement(claim, feeSchedule);
  completed.push(projection);
  return { rules: completed, cobOrder: cob.order, projectedReimbursement: projection.expected, accident };
}

function publicClaim(claim, now = Date.now()) {
  return {
    accountId: claim.accountId,
    patient: claim.patient,
    category: claim.category,
    categoryLabel: CATEGORIES[claim.category].label,
    categoryShort: CATEGORIES[claim.category].short,
    payer: claim.payer,
    facility: claim.facility,
    state: claim.state,
    dos: claim.dos,
    billed: claim.billed,
    expected: claim.expected,
    status: claim.status,
    days: daysSince(claim.dos, now),
    encounter: claim.encounter,
    facts: claim.facts,
    documents: claim.documents.map((doc) => ({ kind: doc.kind, title: doc.title, source: doc.source, sourceLabel: doc.sourceLabel, pages: doc.pages, receivedOn: doc.receivedOn, ocrConfidence: doc.ocr ? doc.ocr.confidence : null })),
    rules: claim.rules,
    projectedReimbursement: claim.projectedReimbursement,
    submission: claim.submission || null,
  };
}

function listClaims(now = Date.now()) {
  const claims = [...claimState.values()].map((claim) => publicClaim(claim, now));
  const open = claims.filter((claim) => claim.status !== 'submitted');
  return {
    success: true,
    client: CLIENT,
    categories: Object.entries(CATEGORIES).map(([id, cat]) => ({ id, ...cat })),
    kpis: {
      openClaims: open.length,
      projectedRecovery: round2(open.reduce((sum, claim) => sum + claim.expected, 0)),
      avgDaysToPayment: AVG_DAYS_TO_PAYMENT,
      stalled: claims.filter((claim) => claim.status === 'stalled').length,
    },
    claims,
  };
}

function getClaim(accountId) {
  const claim = claimState.get(String(accountId || '').trim().toUpperCase());
  if (!claim) throw new ClaimError(`Account ${accountId} is not on the Complex Claims worklist.`, 'CLAIM_NOT_FOUND', 404);
  return claim;
}

async function runPayerRules(data) {
  const startTime = Date.now();
  const requestId = `E360-${uuidv4().slice(0, 8).toUpperCase()}`;
  const claim = getClaim(data.accountId);
  if (claim.status === 'submitted') {
    throw new ClaimError(`Account ${claim.accountId} has already been submitted to ${claim.payer}.`, 'ALREADY_SUBMITTED', 409);
  }
  const completed = [];

  logger.info('e360 payer rules run started', {
    requestId,
    accountId: claim.accountId,
    category: claim.category,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));

    const evaluation = evaluatePayerRules(claim, completed);
    claim.status = 'rules_complete';
    claim.rules = evaluation.rules;
    claim.projectedReimbursement = evaluation.projectedReimbursement;
    const duration = Date.now() - startTime;

    incrementMetric('complex_claims.payer_rules.success', { route: ROUTE, category: claim.category });
    recordTiming('complex_claims.payer_rules.latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      accountId: claim.accountId,
      status: claim.status,
      rules: evaluation.rules,
      cobOrder: evaluation.cobOrder,
      projectedReimbursement: evaluation.projectedReimbursement,
      accidentRecord: evaluation.accident,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    claim.status = 'stalled';
    claim.rules = completed;
    error.rulesCompleted = completed;
    error.accountId = claim.accountId;

    incrementMetric('complex_claims.payer_rules.failure', {
      route: ROUTE,
      category: claim.category,
      errorClass: error.name,
    });
    recordTiming('complex_claims.payer_rules.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('e360 payer rules run failed', {
      requestId,
      accountId: claim.accountId,
      category: claim.category,
      rulesCompleted: completed.map((rule) => rule.rule),
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        category: claim.category,
        alert_path: 'instant',
      },
      extra: { requestId, accountId: claim.accountId, rulesCompleted: completed.map((rule) => rule.rule) },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f6f40dd7.js \u2014 determineCobOrder',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'EnableComp e360 RCM — Complex Claims',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'f6f40dd7',
      slackMemberId: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'category', value: claim.category },
        { key: 'account', value: claim.accountId },
      ],
      extra: { requestId, accountId: claim.accountId, client: CLIENT.name, rulesCompleted: completed.map((rule) => rule.rule) },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for e360 payer rules error', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

async function submitToCarrier(data) {
  const claim = getClaim(data.accountId);
  if (claim.status === 'submitted') {
    throw new ClaimError(`Account ${claim.accountId} was already submitted (${claim.submission.confirmation}).`, 'ALREADY_SUBMITTED', 409);
  }
  if (claim.status !== 'rules_complete') {
    throw new ClaimError(`Run payer rules on ${claim.accountId} before submitting to ${claim.payer}.`, 'RULES_INCOMPLETE', 409);
  }
  await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 200));
  const submittedAt = new Date().toISOString();
  const carrierCode = claim.payer.replace(/[^A-Z]/g, '').slice(0, 3) || 'CAR';
  claim.submission = {
    submittedAt,
    confirmation: `${carrierCode}-${submittedAt.slice(2, 4)}${submittedAt.slice(5, 7)}${submittedAt.slice(8, 10)}-${uuidv4().replace(/\D/g, '').slice(0, 5)}`,
    projectedReimbursement: claim.projectedReimbursement,
    channel: claim.category === 'oos' || claim.category === 'va' ? 'EDI 837I via clearinghouse' : 'Carrier portal (e-bill attachment packet)',
  };
  claim.status = 'submitted';

  logger.info('e360 claim submitted to carrier', { accountId: claim.accountId, payer: claim.payer, confirmation: claim.submission.confirmation, service: SERVICE });
  incrementMetric('complex_claims.submit.success', { category: claim.category });

  return { success: true, accountId: claim.accountId, status: claim.status, payer: claim.payer, submission: claim.submission, projectedReimbursement: claim.projectedReimbursement };
}

resetState();

module.exports = {
  listClaims,
  getClaim: (accountId) => publicClaim(getClaim(accountId)),
  runPayerRules,
  submitToCarrier,
  resetState,
  normalizeAccidentRecord,
  determineCobOrder,
  evaluatePayerRules,
  SEED_CLAIMS,
  CATEGORIES,
  REMEDIATION_DIRECTIVE,
};
