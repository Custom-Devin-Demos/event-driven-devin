const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * UnitedHealth Group — UnitedHealthcare covered services catalog (billed charges)
 */
const SERVICE_CATALOG = [
  { code: 'CPT-99213', name: 'Office Visit — Established Patient', billed: 185.00, category: 'primary-care' },
  { code: 'CPT-80053', name: 'Comprehensive Metabolic Panel', billed: 96.00, category: 'laboratory' },
  { code: 'CPT-85025', name: 'Complete Blood Count w/ Differential', billed: 64.00, category: 'laboratory' },
  { code: 'CPT-93000', name: 'Electrocardiogram, Routine', billed: 128.00, category: 'cardiology' },
  { code: 'CPT-71046', name: 'Chest X-Ray, 2 Views', billed: 210.00, category: 'radiology' },
  { code: 'CPT-90837', name: 'Psychotherapy, 60 Minutes', billed: 245.00, category: 'behavioral-health' },
  { code: 'CPT-97110', name: 'Physical Therapy — Therapeutic Exercise', billed: 132.00, category: 'rehabilitation' },
  { code: 'CPT-99396', name: 'Preventive Visit — Adult', billed: 275.00, category: 'preventive' },
];

/**
 * Benefit plan configuration — member coinsurance rate + processing currency
 */
const PLAN_TIERS = {
  CHOICE_PLUS: { coinsuranceRate: 0.20, currency: 'USD' },
  NAVIGATE: { coinsuranceRate: 0.15, currency: 'USD' },
  HSA_ADVANTAGE: { coinsuranceRate: 0.30, currency: 'USD' },
  MEDICARE_ADVANTAGE: { coinsuranceRate: 0.05, currency: 'USD' },
};

/**
 * Active member incentives — "UnitedHealthcare Rewards" wellness credit.
 * Applied server-side so it appears on the Explanation of Benefits.
 */
const ACTIVE_INCENTIVES = [
  { code: 'REWARD-UHCFIT-2026', name: 'UnitedHealthcare Rewards Wellness Credit', billed: 0, qty: 1 },
];

/**
 * Looks up the in-network negotiated discount tier for a claim's billed total.
 */
function getNetworkDiscount(billedTotal) {
  if (billedTotal >= 800) return { rate: 0.35, label: '35% in-network negotiated rate on claims $800+' };
  if (billedTotal >= 400) return { rate: 0.25, label: '25% in-network negotiated rate on claims $400+' };
  return { rate: 0.15, label: '15% in-network negotiated rate' };
}

/**
 * Merges active member incentives into the claim line items.
 */
function applyIncentives(lines) {
  return [...lines, ...ACTIVE_INCENTIVES];
}

/**
 * Computes the member's cost share for the adjudicated claim.
 */
function computeMemberCostShare(billedTotal, plan) {
  const planConfig = PLAN_TIERS[plan];
  if (!planConfig) {
    throw Object.assign(new Error(`Unknown benefit plan: ${plan}`), { code: 'INVALID_PLAN' });
  }
  const discount = getNetworkDiscount(billedTotal);
  const allowedAmount = billedTotal * (1 - discount.rate);
  const memberResponsibility = allowedAmount * planConfig.coinsuranceRate;
  return {
    billedTotal,
    allowedAmount: Math.round(allowedAmount * 100) / 100,
    planPaid: Math.round((allowedAmount - memberResponsibility) * 100) / 100,
    discountLabel: discount.label,
    memberResponsibility: Math.round(memberResponsibility * 100) / 100,
    currency: planConfig.currency,
  };
}

/**
 * Formats the Explanation of Benefits line detail.
 * BUG: REWARD-UHCFIT-2026 is not in SERVICE_CATALOG, so service.name crashes.
 */
function formatExplanationOfBenefits(allLines) {
  return allLines.map((line) => {
    const service = SERVICE_CATALOG.find((s) => s.code === line.code);
    return {
      code: line.code,
      name: service.name,
      category: service.category,
      qty: line.qty,
      lineBilled: line.billed * line.qty,
    };
  });
}

/**
 * Adjudicates a UnitedHealthcare medical claim and issues the EOB.
 */
async function adjudicateClaim(claimData) {
  const startTime = Date.now();
  const claimId = uuidv4();

  logger.info('Adjudicating UnitedHealthcare medical claim', {
    claimId,
    memberId: claimData.memberId,
    billedTotal: claimData.billedTotal,
    service: 'uhg-claims',
    route: '/api/31328569/claim',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allLines = applyIncentives(claimData.lines);

    const computedBilled = allLines.reduce(
      (sum, line) => sum + line.billed * line.qty,
      0,
    ) || claimData.billedTotal;

    const finalBilled = typeof computedBilled === 'string'
      ? parseFloat(computedBilled)
      : computedBilled;

    const result = computeMemberCostShare(finalBilled, claimData.plan);
    const eob = formatExplanationOfBenefits(allLines);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/31328569/claim',
      source: 'uhg-member-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/31328569/claim',
    });

    return {
      success: true,
      claimId,
      memberResponsibility: result.memberResponsibility,
      allowedAmount: result.allowedAmount,
      planPaid: result.planPaid,
      discountLabel: result.discountLabel,
      eob,
      status: 'adjudicated',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/31328569/claim',
      errorClass: error.name,
      source: 'uhg-member-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/31328569/claim',
      error: 'true',
    });

    logger.error('UnitedHealthcare claim adjudication failed', {
      claimId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      memberId: claimData.memberId,
      service: 'uhg-claims',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/31328569/claim',
        service: 'uhg-claims',
        source: 'uhg-member-portal',
      },
      extra: {
        claimId,
        memberId: claimData.memberId,
        billedTotal: claimData.billedTotal,
        plan: claimData.plan,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      customer: '31328569',
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/31328569.js \u2014 formatExplanationOfBenefits',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: claimData.devinUserId,
      devinEmail: claimData.devinEmail,
      devinOrgId: claimData.devinOrgId,
      service: 'uhg-claims',
      verticalLabel: 'UnitedHealth Group Claim',
      tags: [
        { key: 'route', value: '/api/31328569/claim' },
        { key: 'service', value: 'uhg-claims' },
      ],
      extra: { claimId, memberId: claimData.memberId, billedTotal: claimData.billedTotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'uhg-claims@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from UnitedHealth Group claim error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  adjudicateClaim,
  computeMemberCostShare,
  formatExplanationOfBenefits,
  applyIncentives,
  SERVICE_CATALOG,
  PLAN_TIERS,
};
