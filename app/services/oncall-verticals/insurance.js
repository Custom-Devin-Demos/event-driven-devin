const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

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

const ADJUDICATION_TIMEOUT_MS = 2500;
const ADJUDICATION_ATTEMPTS = 3;

/**
 * Call the external adjudication partner. The partner's response time runs
 * ~4s at p50 during business hours.
 */
function callAdjudicationPartner(claim) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        decision: 'approved',
        adjudicatorRef: `ADJ-${claim.claimId.slice(0, 8)}`,
        approvedAmount: claim.requestedPayout,
      });
    }, 3600 + Math.random() * 900);
  });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`);
      err.code = 'ADJUDICATION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Submit a claim to the adjudication partner, retrying on timeout.
 */
async function adjudicateClaim(claim) {
  let lastError;
  for (let attempt = 1; attempt <= ADJUDICATION_ATTEMPTS; attempt++) {
    try {
      return await withTimeout(
        callAdjudicationPartner(claim),
        ADJUDICATION_TIMEOUT_MS,
        'Adjudication request',
      );
    } catch (error) {
      lastError = error;
      logger.warn('Adjudication attempt failed, retrying', {
        attempt,
        claimId: claim.claimId,
        error: error.message,
        service: 'insurance-api',
      });
    }
  }
  throw lastError;
}

/**
 * Look up a policy by ID.
 */
function lookupPolicy(policyId) {
  const policy = POLICIES.find((p) => p.id === policyId);
  if (!policy) return null;
  return {
    id: policy.id,
    type: policy.type,
    holder: policy.holder,
    deductible: policy.deductible,
    maxPayout: policy.coverage.maxPayout,
    liability: policy.coverage.liability,
    premium: policy.premium,
    status: policy.status,
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
    route: '/api/oncall/insurance/claim',
  });

  try {
    const policy = lookupPolicy(claimData.policyId) || lookupPolicy('POL-5001');

    const netClaimable = claimData.amount - policy.deductible;
    const requestedPayout = Math.min(Math.max(netClaimable, 0), policy.maxPayout);

    const adjudication = await adjudicateClaim({ claimId, requestedPayout });

    const duration = Date.now() - startTime;

    incrementMetric('claim.success', {
      route: '/api/oncall/insurance/claim',
      claimType: claimData.claimType,
    });
    recordTiming('claim.latency', duration, {
      route: '/api/oncall/insurance/claim',
    });

    return {
      success: true,
      claimId,
      policyId: claimData.policyId,
      claimAmount: claimData.amount,
      deductible: parseFloat(policy.deductible.toFixed(2)),
      payout: Math.round(adjudication.approvedAmount * 100) / 100,
      status: 'approved',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('claim.failure', {
      route: '/api/oncall/insurance/claim',
      errorClass: error.name,
    });
    recordTiming('claim.latency', duration, {
      route: '/api/oncall/insurance/claim',
      error: 'true',
    });

    logger.error('Claim processing failed', {
      claimId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      policyId: claimData.policyId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/oncall/insurance/claim',
        service: 'insurance-api',
        claimType: claimData.claimType,
      },
      extra: { claimId, policyId: claimData.policyId, amount: claimData.amount },
    });

    throw error;
  }
}

module.exports = { processClaim, POLICIES, CLAIM_TYPES };
