const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Plan configuration for CVS Health Insurance
 */
const PLAN_CONFIG = {
  ppo: { name: 'CVS Health PPO', deductible: 2000, oopMax: 6000, copay: 30, coinsurance: 0.20 },
  hmo: { name: 'CVS Health HMO', deductible: 1500, oopMax: 5000, copay: 20, coinsurance: 0.15 },
  epo: { name: 'CVS Health EPO', deductible: 1750, oopMax: 5500, copay: 25, coinsurance: 0.18 },
  hdhp: { name: 'CVS Health HDHP', deductible: 3500, oopMax: 7000, copay: 0, coinsurance: 0.10 },
};

/**
 * Mock member database
 */
const MEMBERS = [
  { id: 'CVS-20481973', email: 'sarah.johnson@example.com', name: 'Sarah Johnson', planType: 'ppo', deductibleMet: 1240.00, claimsYTD: 4 },
  { id: 'CVS-20559841', email: 'david.kim@example.com', name: 'David Kim', planType: 'hmo', deductibleMet: 950.00, claimsYTD: 7 },
  { id: 'CVS-20612308', email: 'maria.garcia@example.com', name: 'Maria Garcia', planType: 'epo', deductibleMet: 1750.00, claimsYTD: 12 },
  { id: 'CVS-20487562', email: 'james.wilson@example.com', name: 'James Wilson', planType: 'hdhp', deductibleMet: 2100.00, claimsYTD: 3 },
];

/**
 * Recent claims history for display
 */
const RECENT_CLAIMS = [
  { date: '2026-04-18', provider: 'MinuteClinic - CVS #4821', service: 'Annual Wellness Exam', amount: 0.00, status: 'Covered' },
  { date: '2026-04-02', provider: 'CVS Pharmacy', service: 'Prescription - Atorvastatin 20mg', amount: 12.00, status: 'Processed' },
  { date: '2026-03-15', provider: 'Oak Street Health', service: 'Primary Care Visit', amount: 30.00, status: 'Processed' },
  { date: '2026-02-28', provider: 'CVS Pharmacy', service: 'Prescription - Metformin 500mg', amount: 8.00, status: 'Processed' },
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

  const deductiblePct = Math.min(100, (deductibleMet / deductibleTotal) * 100);

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
    service: 'c65e3d81-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const memberData = findMember(data);
    if (!memberData) {
      const err = new Error('Member not found. Please verify your email and member ID.');
      err.name = 'MemberNotFoundError';
      err.code = 'MEMBER_NOT_FOUND';
      throw err;
    }

    const planDetails = resolvePlanDetails(memberData, data.planType);
    const summary = calculateCoverageSummary(memberData, planDetails);

    const duration = Date.now() - startTime;

    incrementMetric('coverage.lookup.success', {
      route: '/api/c65e3d81/coverage',
      planType: data.planType,
    });
    recordTiming('coverage.lookup.latency', duration, {
      route: '/api/c65e3d81/coverage',
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
      route: '/api/c65e3d81/coverage',
      errorClass: error.name,
      planType: data.planType,
    });
    recordTiming('coverage.lookup.latency', duration, {
      route: '/api/c65e3d81/coverage',
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
        route: '/api/c65e3d81/coverage',
        service: 'c65e3d81-api',
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
      culprit: 'app/services/verticals/c65e3d81.js — processCoverageLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: 'c65e3d81-api',
      verticalLabel: 'Coverage Lookup',
      customer: 'c65e3d81',
      tags: [
        { key: 'route', value: '/api/c65e3d81/coverage' },
        { key: 'service', value: 'c65e3d81-api' },
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
      release: process.env.SENTRY_RELEASE || 'c65e3d81@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from coverage lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCoverageLookup, MEMBERS, RECENT_CLAIMS };
