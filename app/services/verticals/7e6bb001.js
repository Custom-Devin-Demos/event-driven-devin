const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Plan configuration for Humana health plans
 */
const PLAN_CONFIG = {
  'ma-hmo': { name: 'Humana Gold Plus HMO', deductible: 0, oopMax: 4900, copay: 0, coinsurance: 0.20 },
  'ma-ppo': { name: 'HumanaChoice PPO', deductible: 500, oopMax: 6700, copay: 15, coinsurance: 0.20 },
  employer: { name: 'Humana Employer Group PPO', deductible: 1500, oopMax: 5500, copay: 25, coinsurance: 0.20 },
  'dental-vision': { name: 'Humana Extend Dental + Vision', deductible: 50, oopMax: 1500, copay: 0, coinsurance: 0.20 },
};

/**
 * Mock member database
 */
const MEMBERS = [
  { id: 'HUM-73920481', email: 'margaret.thompson@example.com', name: 'Margaret Thompson', planType: 'ma-hmo', deductibleMet: 0.00, claimsYTD: 9 },
  { id: 'HUM-73958204', email: 'robert.chen@example.com', name: 'Robert Chen', planType: 'ma-ppo', deductibleMet: 320.00, claimsYTD: 6 },
  { id: 'HUM-74012937', email: 'linda.martinez@example.com', name: 'Linda Martinez', planType: 'employer', deductibleMet: 1150.00, claimsYTD: 4 },
  { id: 'HUM-73987615', email: 'william.davis@example.com', name: 'William Davis', planType: 'dental-vision', deductibleMet: 50.00, claimsYTD: 3 },
];

/**
 * Recent claims history for display
 */
const RECENT_CLAIMS = [
  { date: '2026-07-14', provider: 'CenterWell Pharmacy', service: 'Prescription - Lisinopril 10mg', amount: 0.00, status: 'Covered' },
  { date: '2026-07-02', provider: 'CenterWell Primary Care', service: 'Annual Wellness Visit', amount: 0.00, status: 'Covered' },
  { date: '2026-06-19', provider: 'CenterWell Pharmacy', service: 'Prescription - Metformin 500mg', amount: 4.00, status: 'Processed' },
  { date: '2026-06-05', provider: 'Norton Healthcare', service: 'Specialist Visit - Cardiology', amount: 15.00, status: 'Processed' },
];

/**
 * Look up a member record by email or member ID.
 */
function findMember(query) {
  const member = MEMBERS.find(
    (m) => m.email === query.email || m.id === query.memberId
  );
  if (!member) return null;
  return {
    profile: {
      id: member.id,
      name: member.name,
      email: member.email,
      planType: member.planType,
    },
    coverage: {
      deductibleMet: member.deductibleMet,
      claimsYTD: member.claimsYTD,
    },
  };
}

/**
 * Resolve plan details for a member's plan type.
 */
function resolvePlanDetails(memberData, requestedPlanType) {
  const planKey = requestedPlanType || memberData.profile.planType;
  const config = PLAN_CONFIG[planKey];
  if (!config) return null;

  return {
    planType: planKey,
    details: [config.name, config.deductible, config.oopMax, config.copay, config.coinsurance],
  };
}

/**
 * Calculate the coverage summary from member data and plan details.
 * Computes remaining deductible, out-of-pocket status, and copay info.
 */
function calculateCoverageSummary(memberData, planDetails) {
  const deductibleTotal = planDetails.config.deductible;
  const deductibleMet = memberData.coverage.deductibleMet;
  const deductibleRemaining = Math.max(0, deductibleTotal - deductibleMet);

  const oopMax = planDetails.config.oopMax;
  const copay = planDetails.config.copay;
  const coinsurance = planDetails.config.coinsurance;

  const deductiblePct = deductibleTotal > 0 ? Math.min(100, (deductibleMet / deductibleTotal) * 100) : 100;

  return {
    planName: planDetails.config.name,
    deductible: deductibleTotal.toFixed(2),
    deductibleMet: deductibleMet.toFixed(2),
    deductibleRemaining: deductibleRemaining.toFixed(2),
    deductiblePct: deductiblePct.toFixed(1),
    oopMax: oopMax.toFixed(2),
    copay: copay.toFixed(2),
    coinsurance: (coinsurance * 100).toFixed(0) + '%',
    claimsYTD: memberData.coverage.claimsYTD,
  };
}

/**
 * Process a coverage status lookup.
 */
async function processCoverageLookup(data) {
  const startTime = Date.now();
  const lookupId = uuidv4();

  logger.info('Processing coverage lookup', {
    lookupId,
    email: data.email,
    memberId: data.memberId,
    planType: data.planType,
    service: '7e6bb001-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const memberData = findMember(data);
    if (!memberData) {
      const err = new Error('Member not found. Please verify your email and Humana member ID.');
      err.name = 'MemberNotFoundError';
      err.code = 'MEMBER_NOT_FOUND';
      throw err;
    }

    const planDetails = resolvePlanDetails(memberData, data.planType);
    const summary = calculateCoverageSummary(memberData, planDetails);

    const duration = Date.now() - startTime;

    incrementMetric('coverage.lookup.success', {
      route: '/api/7e6bb001/coverage',
      planType: data.planType,
    });
    recordTiming('coverage.lookup.latency', duration, {
      route: '/api/7e6bb001/coverage',
    });

    return {
      success: true,
      lookupId,
      member: memberData.profile.name,
      ...summary,
      recentClaims: RECENT_CLAIMS,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('coverage.lookup.failure', {
      route: '/api/7e6bb001/coverage',
      errorClass: error.name,
      planType: data.planType,
    });
    recordTiming('coverage.lookup.latency', duration, {
      route: '/api/7e6bb001/coverage',
      error: 'true',
    });

    logger.error('Coverage lookup failed', {
      lookupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      email: data.email,
      memberId: data.memberId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/7e6bb001/coverage',
        service: '7e6bb001-api',
        planType: data.planType,
      },
      extra: {
        lookupId,
        email: data.email,
        memberId: data.memberId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/7e6bb001.js — processCoverageLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: '7e6bb001-api',
      verticalLabel: 'Coverage Lookup',
      customer: '7e6bb001',
      tags: [
        { key: 'route', value: '/api/7e6bb001/coverage' },
        { key: 'service', value: '7e6bb001-api' },
        { key: 'planType', value: data.planType },
      ],
      extra: { lookupId, email: data.email, memberId: data.memberId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '7e6bb001@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from coverage lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCoverageLookup, MEMBERS, RECENT_CLAIMS };
