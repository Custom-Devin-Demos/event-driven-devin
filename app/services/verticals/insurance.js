const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Insurance policies for the demo
 */
const POLICIES = [
  { id: 'POL-5001', type: 'auto', holder: 'Alice Chen', deductible: 500, coverage: { maxPayout: 50000, liability: 100000 }, premium: 1200, status: 'active' },
  { id: 'POL-5002', type: 'home', holder: 'Bob Martinez', deductible: 1000, coverage: { maxPayout: 250000, liability: 300000 }, premium: 2400, status: 'active' },
  { id: 'POL-5003', type: 'life', holder: 'Carol Nguyen', deductible: 0, coverage: { maxPayout: 500000, liability: 0 }, premium: 3600, status: 'active' },
  { id: 'POL-5004', type: 'auto', holder: 'David Park', deductible: 250, coverage: { maxPayout: 75000, liability: 150000 }, premium: 1800, status: 'active' },
];

/**
 * Claim types for the UI
 */
const CLAIM_TYPES = [
  { id: 'collision', label: 'Vehicle Collision', policyType: 'auto' },
  { id: 'weather', label: 'Weather Damage', policyType: 'home' },
  { id: 'theft', label: 'Theft / Burglary', policyType: 'home' },
  { id: 'medical', label: 'Medical Expense', policyType: 'life' },
  { id: 'liability', label: 'Liability Claim', policyType: 'auto' },
];

/**
 * Look up a policy by ID.
 */
function lookupPolicy(policyId) {
  const policy = POLICIES.find((p) => p.id === policyId);
  if (!policy) return null;

  return {
    policyData: {
      id: policy.id,
      type: policy.type,
      holder: policy.holder,
      terms: {
        deductible: policy.deductible,
        maxPayout: policy.coverage.maxPayout,
        liability: policy.coverage.liability,
      },
      premium: policy.premium,
      status: policy.status,
    },
    meta: {
      retrievedAt: Date.now(),
      source: 'policy-cache',
      version: '2.0',
    },
  };
}

/**
 * Extract coverage limits from a policy lookup result.
 */
function extractCoverageLimits(policyResult) {
  const limits = policyResult.policy;
  return {
    maxPayout: limits.coverage.maxPayout,
    liability: limits.coverage.liability,
    deductible: limits.deductible,
  };
}

/**
 * Process an insurance claim.
 */
async function processClaim(claimData) {
  const startTime = Date.now();
  const claimId = uuidv4();

  logger.info('Processing claim', {
    claimId,
    policyId: claimData.policyId,
    claimType: claimData.claimType,
    amount: claimData.amount,
    service: 'insurance-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

    const result = lookupPolicy(claimData.policyId);
    const limits = extractCoverageLimits(result);

    const netClaimable = claimData.amount - limits.deductible;
    const payout = Math.min(netClaimable, limits.maxPayout);

    const duration = Date.now() - startTime;

    incrementMetric('claim.success', {
      route: '/api/insurance/claim',
      claimType: claimData.claimType,
    });
    recordTiming('claim.latency', duration, {
      route: '/api/insurance/claim',
    });

    return {
      success: true,
      claimId,
      policyId: claimData.policyId,
      claimAmount: claimData.amount,
      deductible: parseFloat(limits.deductible.toFixed(2)),
      payout: Math.round(payout * 100) / 100,
      status: 'approved',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('claim.failure', {
      route: '/api/insurance/claim',
      errorClass: error.name,
    });
    recordTiming('claim.latency', duration, {
      route: '/api/insurance/claim',
      error: 'true',
    });

    logger.error('Claim processing failed', {
      claimId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      policyId: claimData.policyId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/insurance/claim',
        service: 'insurance-api',
        claimType: claimData.claimType,
      },
      extra: { claimId, policyId: claimData.policyId, amount: claimData.amount },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/insurance.js — processClaim',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: claimData.devinUserId,
      devinEmail: claimData.devinEmail,
      devinOrgId: claimData.devinOrgId,
      service: 'insurance-api',
      verticalLabel: 'Insurance Claim',
      tags: [
        { key: 'route', value: '/api/insurance/claim' },
        { key: 'service', value: 'insurance-api' },
      ],
      extra: { claimId, policyId: claimData.policyId, amount: claimData.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'shield-insurance@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from claim error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processClaim, POLICIES, CLAIM_TYPES };
