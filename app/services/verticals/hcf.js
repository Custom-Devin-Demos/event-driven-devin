const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const MEMBERSHIPS = {
  'HCF-8815427': {
    memberName: 'Alicia Nguyen',
    state: 'NSW',
    coverTierCode: 'top_extras_2026',
    coverTierLabel: 'Top Extras 60 (2026)',
    people: [
      { personId: 'P01', name: 'Alicia Nguyen', relationship: 'Member' },
      { personId: 'P02', name: 'Jordan Nguyen', relationship: 'Partner' },
    ],
  },
  'HCF-4420913': {
    memberName: 'Daniel Whitcombe',
    state: 'VIC',
    coverTierCode: 'mid_extras',
    coverTierLabel: 'Mid Extras 60',
    people: [
      { personId: 'P01', name: 'Daniel Whitcombe', relationship: 'Member' },
    ],
  },
  'HCF-6733208': {
    memberName: 'Priya Raman',
    state: 'QLD',
    coverTierCode: 'starter_extras',
    coverTierLabel: 'Starter Extras 50',
    people: [
      { personId: 'P01', name: 'Priya Raman', relationship: 'Member' },
      { personId: 'P02', name: 'Leo Raman', relationship: 'Dependant' },
    ],
  },
};

const BENEFIT_SCHEDULES = {
  mid_extras: {
    label: 'Mid Extras 60',
    dentalAnnualLimit: 700,
    opticalAnnualLimit: 200,
    physioAnnualLimit: 400,
    benefitPercentage: 0.6,
    assessorQueue: 'extras-standard',
  },
  starter_extras: {
    label: 'Starter Extras 50',
    dentalAnnualLimit: 500,
    opticalAnnualLimit: 150,
    physioAnnualLimit: 300,
    benefitPercentage: 0.5,
    assessorQueue: 'extras-standard',
  },
  // top_extras_2026 ships with the 1 April 2026 benefit table roll-out; schedule registration pending
};

const SERVICE_TYPES = {
  dental: {
    label: 'Dental — comprehensive exam, scale & clean',
    benefitCode: 'dental',
    itemNumbers: '012, 114, 121',
    feeCharged: 245,
    providerType: 'Dentist',
  },
  optical: {
    label: 'Optical — prescription glasses',
    benefitCode: 'optical',
    itemNumbers: 'OPT-SV',
    feeCharged: 349,
    providerType: 'Optometrist',
  },
  physiotherapy: {
    label: 'Physiotherapy — standard consultation',
    benefitCode: 'physio',
    itemNumbers: '500',
    feeCharged: 95,
    providerType: 'Physiotherapist',
  },
  chiropractic: {
    label: 'Chiropractic — subsequent consultation',
    benefitCode: 'physio',
    itemNumbers: '201',
    feeCharged: 75,
    providerType: 'Chiropractor',
  },
  remedial_massage: {
    label: 'Remedial massage — 60 minutes',
    benefitCode: 'physio',
    itemNumbers: '103',
    feeCharged: 120,
    providerType: 'Remedial massage therapist',
  },
};

const ASSESSORS = [
  {
    id: 'ASR-114',
    name: 'Megan Doyle',
    phone: '13 13 34',
    assessorQueue: 'extras-standard',
  },
  {
    id: 'ASR-118',
    name: 'Sam Kirkwood',
    phone: '13 13 34',
    assessorQueue: 'extras-top',
  },
];

const HCF_SLACK_MEMBER_ID = process.env.HCF_SLACK_MEMBER_ID || '';
const SENTRY_ISSUE_QUERY = 'is:unresolved dentalAnnualLimit';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the HCF extras claim failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/insurance/claim and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/hcf/claim, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the HCF extras claims page at app/public/verticals/hcf.html (page route GET /hcf), whose "Submit claim" action posts to POST /api/hcf/claim in app/routes/verticals/hcf.js. The claims benefit pipeline lives in app/services/verticals/hcf.js: submitClaim -> calculateBenefitPayable -> resolveBenefitSchedule. Start at resolveBenefitSchedule: it looks up BENEFIT_SCHEDULES by the cover tier code carried on the membership, and the top_extras_2026 tier shipped with the 1 April 2026 benefit table roll-out without a registered benefit schedule, so the lookup returns undefined and calculateBenefitPayable dereferences it while applying the dental annual limit. Register the missing cover tier's benefit schedule and make the lookup fail as a handled claims error routed to an assessor instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing a dental claim for membership HCF-8815427 to /api/hcf/claim, which must return a successful benefit assessment, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /hcf page in a real browser, submit the pre-filled dental claim for HCF-8815427, and record your screen for the whole submission so the recording shows the form, the click, and the successful benefit assessment that replaces the previous TypeError panel. Attach a screenshot of that successful benefit assessment and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function resolveBenefitSchedule(membership) {
  return BENEFIT_SCHEDULES[membership.coverTierCode];
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function assignAssessor(schedule) {
  return ASSESSORS.find((assessor) => assessor.assessorQueue === schedule.assessorQueue);
}

function calculateBenefitPayable(membership, service, _person) {
  const schedule = resolveBenefitSchedule(membership);
  let annualLimit;

  if (service.benefitCode === 'optical') {
    annualLimit = schedule.opticalAnnualLimit;
  } else if (service.benefitCode === 'physio') {
    annualLimit = schedule.physioAnnualLimit;
  } else {
    annualLimit = schedule.dentalAnnualLimit;
  }

  const feeCharged = Number(service.feeCharged);
  const benefitPaid = roundMoney(Math.min(
    feeCharged * schedule.benefitPercentage,
    annualLimit,
  ));
  const outOfPocket = roundMoney(feeCharged - benefitPaid);

  return {
    schedule,
    annualLimit,
    benefitPaid,
    outOfPocket,
    assessor: assignAssessor(schedule),
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
  const claimNumber = `HCF-CLM-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const membershipNumber = data.membershipNumber;
  const serviceType = data.serviceType;
  const serviceDate = data.serviceDate;
  const membership = MEMBERSHIPS[membershipNumber];
  const service = SERVICE_TYPES[serviceType];

  if (!membershipNumber || !String(membershipNumber).trim() || !membership) {
    throw validationError(`Unknown membership number: ${membershipNumber || '(none)'}`);
  }
  if (!service) {
    throw validationError(`Unknown service type: ${serviceType || '(none)'}`);
  }
  if (!serviceDate) {
    throw validationError('Service date is required');
  }
  if (!data.providerName || !String(data.providerName).trim()) {
    throw validationError('Provider name is required');
  }

  const person = membership.people.find((candidate) => candidate.personId === data.personId)
    || membership.people[0];
  const claimService = Object.prototype.hasOwnProperty.call(data, 'feeCharged')
    ? { ...service, feeCharged: data.feeCharged }
    : service;

  logger.info('Submitting HCF extras claim', {
    claimNumber,
    membershipNumber,
    serviceType,
    serviceDate,
    service: 'customer-hcf-claim',
    route: '/api/hcf/claim',
  });

  try {
    const benefit = calculateBenefitPayable(membership, claimService, person);
    const paymentExpectedBy = new Date();
    paymentExpectedBy.setUTCDate(paymentExpectedBy.getUTCDate() + 2);
    const submittedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('hcf_claim.success', {
      route: '/api/hcf/claim',
      serviceType,
      coverTier: membership.coverTierCode,
    });
    recordTiming('hcf_claim.latency', duration, {
      route: '/api/hcf/claim',
    });

    return {
      success: true,
      claimNumber,
      status: 'received',
      membershipNumber,
      memberName: membership.memberName,
      coverTier: benefit.schedule.label,
      patientName: person.name,
      serviceType: claimService.label,
      serviceDate,
      providerName: data.providerName,
      itemNumbers: claimService.itemNumbers,
      feeCharged: Number(claimService.feeCharged),
      benefitPaid: benefit.benefitPaid,
      outOfPocket: benefit.outOfPocket,
      annualLimit: benefit.annualLimit,
      benefitPaidTo: 'Nominated bank account ending 4417',
      assessor: {
        id: benefit.assessor.id,
        name: benefit.assessor.name,
        phone: benefit.assessor.phone,
      },
      paymentExpectedBy: paymentExpectedBy.toISOString(),
      submittedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const coverTierCode = membership && membership.coverTierCode;

    incrementMetric('hcf_claim.failure', {
      route: '/api/hcf/claim',
      errorClass: error.name,
      serviceType,
      coverTier: coverTierCode,
    });
    recordTiming('hcf_claim.latency', duration, {
      route: '/api/hcf/claim',
      error: 'true',
    });

    logger.error('HCF extras claim submission failed', {
      claimNumber,
      membershipNumber,
      serviceType,
      serviceDate,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-hcf-claim',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/hcf/claim',
        service: 'customer-hcf-claim',
        coverTier: coverTierCode,
      },
      extra: {
        claimNumber,
        membershipNumber,
        coverTierCode,
        serviceType,
        serviceDate,
        receiptCount: data.receiptCount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/hcf.js — calculateBenefitPayable',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-hcf-claim',
      verticalLabel: 'HCF Extras — Make a Claim',
      customer: 'hcf',
      slackMemberId: data.devinEmail ? '' : HCF_SLACK_MEMBER_ID,
      slackMemberIdFallback: HCF_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/hcf/claim' },
        { key: 'service', value: 'customer-hcf-claim' },
        { key: 'coverTier', value: coverTierCode },
        { key: 'serviceType', value: serviceType },
      ],
      extra: {
        claimNumber,
        membershipNumber,
        coverTierCode,
        serviceType,
        serviceDate,
        receiptCount: data.receiptCount,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-hcf-claim@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for HCF claim error', {
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
  calculateBenefitPayable,
  assignAssessor,
  roundMoney,
  MEMBERSHIPS,
  BENEFIT_SCHEDULES,
  SERVICE_TYPES,
  ASSESSORS,
  REMEDIATION_DIRECTIVE,
};
