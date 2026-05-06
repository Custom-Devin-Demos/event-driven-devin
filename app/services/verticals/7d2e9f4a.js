const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Plan coverage configuration
 */
const PLAN_CONFIG = {
  ppo: { deductible: 1500, coinsurance: 0.20, outOfPocketMax: 6000, copay: 40 },
  hmo: { deductible: 1000, coinsurance: 0.15, outOfPocketMax: 4500, copay: 25 },
  epo: { deductible: 1250, coinsurance: 0.18, outOfPocketMax: 5500, copay: 35 },
};

/**
 * Mock claims database
 */
const CLAIMS = [
  { claimNumber: 'CLM-2026-00194827', memberId: 'CEN-882041593', provider: 'Mercy Health System', service: 'Outpatient Surgery', amount: 8450.00, planType: 'ppo', status: 'processing', dateOfService: '2026-04-15', diagnosis: 'K80.20', coverage: { networkTier: 'in-network', preAuthorized: true, deductibleMet: 1200.00 } },
  { claimNumber: 'CLM-2026-00194828', memberId: 'CEN-882041593', provider: 'CVS Pharmacy', service: 'Prescription - Tier 2', amount: 285.00, planType: 'ppo', status: 'approved', dateOfService: '2026-04-20', diagnosis: 'J06.9', coverage: { networkTier: 'in-network', preAuthorized: false, deductibleMet: 1500.00 } },
  { claimNumber: 'CLM-2026-00194829', memberId: 'CEN-445927301', provider: 'Cleveland Clinic', service: 'Diagnostic Imaging - MRI', amount: 3200.00, planType: 'hmo', status: 'pending', dateOfService: '2026-04-22', diagnosis: 'M54.5', coverage: { networkTier: 'in-network', preAuthorized: true, deductibleMet: 750.00 } },
  { claimNumber: 'CLM-2026-00194830', memberId: 'CEN-445927301', provider: 'Quest Diagnostics', service: 'Laboratory - Blood Panel', amount: 520.00, planType: 'hmo', status: 'approved', dateOfService: '2026-04-18', diagnosis: 'Z00.00', coverage: { networkTier: 'in-network', preAuthorized: false, deductibleMet: 1000.00 } },
];

/**
 * Recent claims activity for display
 */
const RECENT_CLAIMS = [
  { date: '2026-04-22', claimNumber: 'CLM-2026-00194829', provider: 'Cleveland Clinic', amount: 3200.00, status: 'Pending' },
  { date: '2026-04-20', claimNumber: 'CLM-2026-00194828', provider: 'CVS Pharmacy', amount: 285.00, status: 'Approved' },
  { date: '2026-04-18', claimNumber: 'CLM-2026-00194830', provider: 'Quest Diagnostics', amount: 520.00, status: 'Approved' },
  { date: '2026-04-15', claimNumber: 'CLM-2026-00194827', provider: 'Mercy Health System', amount: 8450.00, status: 'Processing' },
];

/**
 * Look up a claim record by claim number and member ID.
 * Returns the raw claim data from the database.
 */
function findClaim(query) {
  const claim = CLAIMS.find(
    (c) => c.claimNumber === query.claimNumber || c.memberId === query.memberId
  );
  if (!claim) return null;
  return {
    details: {
      claimNumber: claim.claimNumber,
      memberId: claim.memberId,
      provider: claim.provider,
      service: claim.service,
      amount: claim.amount,
      status: claim.status,
      dateOfService: claim.dateOfService,
      diagnosis: claim.diagnosis,
    },
    coverage: {
      networkTier: claim.coverage.networkTier,
      preAuthorized: claim.coverage.preAuthorized,
      deductibleMet: claim.coverage.deductibleMet,
    },
  };
}

/**
 * Resolve the coverage details for a claim based on plan type.
 * Returns the plan configuration with computed coverage values.
 */
function resolveCoverageDetails(claimData, requestedPlan) {
  const planKey = requestedPlan || claimData.details.planType;
  const config = PLAN_CONFIG[planKey];
  if (!config) return null;

  return {
    planType: planKey,
    coverageItems: [config.deductible, config.coinsurance, config.outOfPocketMax, config.copay],
  };
}

/**
 * Calculate claim reimbursement from claim data and coverage details.
 * Applies deductible, coinsurance, and out-of-pocket limits.
 */
function calculateClaimReimbursement(claimData, coverageDetails) {
  const chargedAmount = claimData.details.amount;
  const deductible = coverageDetails.coverage.deductible;
  const deductibleMet = claimData.coverage.deductibleMet;

  const remainingDeductible = Math.max(0, deductible - deductibleMet);
  const afterDeductible = Math.max(0, chargedAmount - remainingDeductible);
  const coinsurance = coverageDetails.coverage.coinsurance;
  const memberShare = afterDeductible * coinsurance;
  const planPays = afterDeductible - memberShare;

  return {
    chargedAmount: chargedAmount.toFixed(2),
    deductibleApplied: remainingDeductible.toFixed(2),
    coveredAmount: afterDeductible.toFixed(2),
    coinsurance: (coinsurance * 100).toFixed(0) + '%',
    memberResponsibility: memberShare.toFixed(2),
    reimbursementAmount: planPays.toFixed(2),
    outOfPocketRemaining: calculateOutOfPocketRemaining(claimData, coverageDetails, memberShare),
  };
}

/**
 * Determine remaining out-of-pocket for the benefit year.
 */
function calculateOutOfPocketRemaining(claimData, coverageDetails, memberShare) {
  const oopMax = PLAN_CONFIG[coverageDetails.planType].outOfPocketMax;
  const priorOop = claimData.coverage.deductibleMet * 0.5;
  return {
    max: oopMax,
    used: (priorOop + memberShare).toFixed(2),
    remaining: Math.max(0, oopMax - priorOop - memberShare).toFixed(2),
  };
}

/**
 * Process a claim status lookup.
 */
async function processClaimLookup(data) {
  const startTime = Date.now();
  const lookupId = uuidv4();

  logger.info('Processing claim status lookup', {
    lookupId,
    claimNumber: data.claimNumber,
    memberId: data.memberId,
    planType: data.planType,
    service: '7d2e9f4a-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const claimData = findClaim(data);
    if (!claimData) {
      const err = new Error('Claim not found. Please verify your claim number and member ID.');
      err.name = 'ClaimNotFoundError';
      err.code = 'CLAIM_NOT_FOUND';
      throw err;
    }

    const coverageDetails = resolveCoverageDetails(claimData, data.planType);
    const reimbursement = calculateClaimReimbursement(claimData, coverageDetails);

    const duration = Date.now() - startTime;

    incrementMetric('claim.lookup.success', {
      route: '/api/7d2e9f4a/claim',
      planType: data.planType,
    });
    recordTiming('claim.lookup.latency', duration, {
      route: '/api/7d2e9f4a/claim',
    });

    return {
      success: true,
      lookupId,
      claim: claimData.details,
      reimbursement,
      recentClaims: RECENT_CLAIMS,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('claim.lookup.failure', {
      route: '/api/7d2e9f4a/claim',
      errorClass: error.name,
      planType: data.planType,
    });
    recordTiming('claim.lookup.latency', duration, {
      route: '/api/7d2e9f4a/claim',
      error: 'true',
    });

    logger.error('Claim status lookup failed', {
      lookupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      claimNumber: data.claimNumber,
      memberId: data.memberId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/7d2e9f4a/claim',
        service: '7d2e9f4a-api',
        planType: data.planType,
      },
      extra: {
        lookupId,
        claimNumber: data.claimNumber,
        memberId: data.memberId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/7d2e9f4a.js — processClaimLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: '7d2e9f4a-api',
      verticalLabel: 'Claim Status Lookup',
      customer: '7d2e9f4a',
      tags: [
        { key: 'route', value: '/api/7d2e9f4a/claim' },
        { key: 'service', value: '7d2e9f4a-api' },
        { key: 'planType', value: data.planType },
      ],
      extra: { lookupId, claimNumber: data.claimNumber, memberId: data.memberId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '7d2e9f4a@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from claim lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processClaimLookup, CLAIMS, RECENT_CLAIMS };
