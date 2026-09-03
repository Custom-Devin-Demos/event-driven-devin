const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const MEMBERSHIPS = {
  'AU-HI-7731942': {
    membershipNumber: 'AU-HI-7731942',
    memberName: 'Jarrod Vanstan',
    state: 'VIC',
    productCode: 'gold_hospital_top_extras_2026',
    productLabel: 'Gold Hospital + Top Extras (2026)',
    persons: [
      { id: 'P1', label: 'Jarrod Vanstan (policy holder)' },
      { id: 'P2', label: 'Elise Vanstan (partner)' },
    ],
  },
  'AU-HI-4402817': {
    membershipNumber: 'AU-HI-4402817',
    memberName: 'Priya Natarajan',
    state: 'NSW',
    productCode: 'silver_plus_hospital_extras',
    productLabel: 'Silver Plus Hospital + Extras',
    persons: [
      { id: 'P1', label: 'Priya Natarajan (policy holder)' },
    ],
  },
  'AU-HI-9186530': {
    membershipNumber: 'AU-HI-9186530',
    memberName: 'Tom Whitlam',
    state: 'QLD',
    productCode: 'basic_plus_hospital',
    productLabel: 'Basic Plus Hospital',
    persons: [
      { id: 'P1', label: 'Tom Whitlam (policy holder)' },
    ],
  },
};

// Benefit schedules registered with the claims platform, keyed by the
// product code carried on the membership.
const BENEFIT_SCHEDULES = {
  silver_plus_hospital_extras: {
    label: 'Silver Plus Hospital + Extras',
    hospitalExcess: 500,
    extrasLimits: { dental: 800, optical: 250, physio: 500, pharmacy: 300, ambulance: 0 },
    extrasRebatePct: 60,
    assessmentQueue: 'health-standard',
  },
  basic_plus_hospital: {
    label: 'Basic Plus Hospital',
    hospitalExcess: 750,
    extrasLimits: { dental: 0, optical: 0, physio: 0, pharmacy: 0, ambulance: 0 },
    extrasRebatePct: 0,
    assessmentQueue: 'health-standard',
  },
  // gold_hospital_top_extras_2026 ships with the 2026 product refresh; schedule registration pending
};

const CLAIM_CATEGORIES = {
  hospital: {
    label: 'Hospital',
    benefitType: 'hospital',
    typicalCharge: 4850,
    severity: 'high',
  },
  dental: {
    label: 'Dental',
    benefitType: 'extras',
    typicalCharge: 320,
    severity: 'low',
  },
  optical: {
    label: 'Optical',
    benefitType: 'extras',
    typicalCharge: 410,
    severity: 'low',
  },
  physio: {
    label: 'Physio',
    benefitType: 'extras',
    typicalCharge: 115,
    severity: 'low',
  },
  ambulance: {
    label: 'Ambulance',
    benefitType: 'extras',
    typicalCharge: 1290,
    severity: 'medium',
  },
  pharmacy: {
    label: 'Pharmacy',
    benefitType: 'extras',
    typicalCharge: 86,
    severity: 'low',
  },
};

const ASSESSORS = [
  {
    id: 'ASR-301',
    name: 'Hannah Kowalski',
    phone: '13 29 39',
    assessmentQueue: 'health-standard',
  },
  {
    id: 'ASR-302',
    name: 'Liam Ferreira',
    phone: '13 29 39',
    assessmentQueue: 'health-priority',
  },
];

const AUSUNITY_SLACK_MEMBER_ID = process.env.AUSUNITY_SLACK_MEMBER_ID || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved hospitalExcess';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Australian Unity claims failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/insurance/claim and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/ausunity/claim, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Australian Unity member claims page at app/public/verticals/ausunity.html (page route GET /ausunity), whose "Submit claim" action posts to POST /api/ausunity/claim in app/routes/verticals/ausunity.js. The benefit assessment pipeline lives in app/services/verticals/ausunity.js: submitClaim -> calculateBenefitAssessment -> resolveBenefitSchedule. Start at resolveBenefitSchedule: it looks up BENEFIT_SCHEDULES by the product code carried on the membership, and the gold_hospital_top_extras_2026 product shipped with the 2026 product refresh without a registered benefit schedule, so the lookup returns undefined and calculateBenefitAssessment dereferences it while applying the hospital excess. Register the missing product's benefit schedule and make the lookup fail as a handled claims error routed to an assessor instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing a hospital claim for membership AU-HI-7731942 to /api/ausunity/claim, which must return a successful benefit assessment, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /ausunity page in a real browser, submit the pre-filled hospital claim for AU-HI-7731942, and record your screen for the whole submission so the recording shows the form, the click, and the successful assessment that replaces the previous TypeError panel. Attach a screenshot of that successful assessment and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function resolveBenefitSchedule(membership) {
  return BENEFIT_SCHEDULES[membership.productCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function assignAssessor(schedule, _category) {
  return ASSESSORS.find((assessor) => assessor.assessmentQueue === schedule.assessmentQueue);
}

function calculateBenefitAssessment(membership, category, amount) {
  const schedule = resolveBenefitSchedule(membership);
  let benefit;
  let excessApplied = 0;

  if (category.benefitType === 'hospital') {
    excessApplied = schedule.hospitalExcess;
    benefit = Math.max(amount - excessApplied, 0);
  } else {
    const limit = schedule.extrasLimits[category.label.toLowerCase()] || 0;
    benefit = Math.min(amount * (schedule.extrasRebatePct / 100), limit);
  }

  const assessor = assignAssessor(schedule, category);

  return {
    schedule,
    excessApplied: roundMoney(excessApplied),
    benefit: roundMoney(benefit),
    gap: roundMoney(Math.max(amount - benefit, 0)),
    assessor,
  };
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_CLAIM';
  error.statusCode = 400;
  return error;
}

async function submitClaim(data) {
  const startTime = Date.now();
  const claimNumber = `AU-CLM-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const membershipNumber = data.membershipNumber;
  const claimCategory = data.claimCategory;
  const serviceDate = data.serviceDate;
  const amount = Number(data.amount);
  const membership = MEMBERSHIPS[membershipNumber];
  const category = CLAIM_CATEGORIES[claimCategory];

  if (!membershipNumber || !String(membershipNumber).trim() || !membership) {
    throw validationError(`Unknown membership number: ${membershipNumber || '(none)'}`);
  }
  if (!category) {
    throw validationError(`Unknown claim category: ${claimCategory || '(none)'}`);
  }
  if (!data.providerName || !String(data.providerName).trim()) {
    throw validationError('Provider name is required');
  }
  if (!serviceDate) {
    throw validationError('Date of service is required');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw validationError('Claim amount must be greater than zero');
  }

  const person = membership.persons.find((candidate) => candidate.id === data.personId)
    || membership.persons[0];

  logger.info('Submitting Australian Unity health claim', {
    claimNumber,
    membershipNumber,
    claimCategory,
    serviceDate,
    amount,
    service: 'customer-ausunity-claim',
    route: '/api/ausunity/claim',
  });

  try {
    const assessment = calculateBenefitAssessment(membership, category, amount);
    const paymentDate = new Date(`${serviceDate}T05:00:00.000Z`);
    paymentDate.setUTCDate(paymentDate.getUTCDate() + 2);
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('ausunity_claim.success', {
      route: '/api/ausunity/claim',
      claimCategory,
      product: membership.productCode,
    });
    recordTiming('ausunity_claim.latency', duration, {
      route: '/api/ausunity/claim',
    });

    return {
      success: true,
      claimNumber,
      status: 'received',
      membershipNumber,
      memberName: membership.memberName,
      person: person.label,
      product: assessment.schedule.label,
      claimCategory: category.label,
      providerName: data.providerName,
      serviceDate,
      amountClaimed: roundMoney(amount),
      excessApplied: assessment.excessApplied,
      benefitPayable: assessment.benefit,
      gapPayable: assessment.gap,
      assessor: {
        id: assessment.assessor.id,
        name: assessment.assessor.name,
        phone: assessment.assessor.phone,
      },
      paymentExpectedBy: paymentDate.toISOString(),
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const productCode = membership && membership.productCode;

    incrementMetric('ausunity_claim.failure', {
      route: '/api/ausunity/claim',
      errorClass: error.name,
      claimCategory,
      product: productCode,
    });
    recordTiming('ausunity_claim.latency', duration, {
      route: '/api/ausunity/claim',
      error: 'true',
    });

    logger.error('Australian Unity claim submission failed', {
      claimNumber,
      membershipNumber,
      claimCategory,
      serviceDate,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-ausunity-claim',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/ausunity/claim',
        service: 'customer-ausunity-claim',
        product: productCode,
      },
      extra: {
        claimNumber,
        membershipNumber,
        productCode,
        claimCategory,
        serviceDate,
        amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/ausunity.js — calculateBenefitAssessment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-ausunity-claim',
      verticalLabel: 'Australian Unity — Make a claim',
      customer: 'ausunity',
      slackMemberId: data.devinEmail ? '' : AUSUNITY_SLACK_MEMBER_ID,
      slackMemberIdFallback: AUSUNITY_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/ausunity/claim' },
        { key: 'service', value: 'customer-ausunity-claim' },
        { key: 'product', value: productCode },
        { key: 'claimCategory', value: claimCategory },
      ],
      extra: {
        claimNumber,
        membershipNumber,
        productCode,
        claimCategory,
        serviceDate,
        amount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-ausunity-claim@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Australian Unity claim error', {
        claimNumber,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  submitClaim,
  resolveBenefitSchedule,
  assignAssessor,
  calculateBenefitAssessment,
  MEMBERSHIPS,
  BENEFIT_SCHEDULES,
  CLAIM_CATEGORIES,
  ASSESSORS,
  REMEDIATION_DIRECTIVE,
};
