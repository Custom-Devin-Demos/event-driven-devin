const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  PLAN_CONFIG,
  MEMBERS,
  SERVICES,
  RECENT_CLAIMS,
  findMember,
  findService,
} = require('./7c6a6ef9-members');

const SERVICE = 'customer-7c6a6ef9-member-coverage';
const ROUTE = '/api/7c6a6ef9/coverage';
const ESTIMATE_ROUTE = '/api/7c6a6ef9/cost-estimate';

/** Network default applied to members whose plan assignment has not been mapped. */
const DEFAULT_PLAN = 'ppo';

/** Slack member to page when a coverage lookup fails and no requester email is known. */
const ONCALL_SLACK_MEMBER_ID = process.env.DEMO_ONCALL_SLACK_MEMBER_ID || 'U08S7AVJ478';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Highmark enGen member coverage vertical:',
  '- Service: `app/services/verticals/7c6a6ef9.js`',
  '- Member records, plan configuration & service catalog: `app/services/verticals/7c6a6ef9-members.js`',
  '- Route: `app/routes/verticals/7c6a6ef9.js`',
  '- Page: `app/public/verticals/7c6a6ef9.html` (served at `/7c6a6ef9` and `/engen-snow`)',
  '- Prevention control: `scripts/7c6a6ef9-benefits-audit.js` (`npm run audit:engen`)',
  '',
  '*Treat this as a field-migration defect, not a one-line crash.* The 2026 benefit-year renewal moved plan assignment on member records to a new location (see `7c6a6ef9-members.js`). Every consumer of the old location is broken; only one of them crashes.',
  '',
  '*Remediation plan — once the crash is root-caused, run these three workstreams in parallel as child sessions, wait for them, then summarize in the ServiceNow incident:*',
  '1. *Blast radius in code* — find every consumer of the moved field in the service (coverage-status AND cost-estimate paths, telemetry included). The cost-estimate path does not crash: it silently falls back to the PPO network default, so HMO, EPO and HDHP members are quoted PPO deductibles, copays and coinsurance — an HDHP member is told the deductible is met and a specialist visit costs $30 when the plan still owes $1,400 of deductible. The only signal is the `cost_estimate.quoted` metric carrying `plan:ppo` on members whose enrolled plan is not PPO. Route all consumers through one shared resolver that fails loudly when a plan cannot be resolved, add regression tests for both paths, run `npm test` and `npm run lint`.',
  '2. *Blast radius in ServiceNow* — using the same Table API credentials as the incident write-back, query open incidents in assignment group "Member Benefits Platform Engineering" (state < 6) that predate this incident and mention cost estimates, deductibles, copays or plan type. Decide which are the silent symptom of this same defect. For each: add a work note linking this incident and the fix PR, set `parent_incident` to this incident sys_id, and resolve it (`state` 6, `close_code` "Solution provided"). Report their numbers and count.',
  '3. *Prevention* — run `npm run audit:engen`. It resolves benefits for every member record through both the coverage-status and cost-estimate paths and exits non-zero on any unresolved or silently downgraded plan; it is not wired into CI, which is why this shipped. Wire it into `npm test` (or the CI workflow) so a plan-assignment gap fails before it ships.',
  '',
  'Fold all code workstreams into a single pull request against `main`. If a child session cannot reach ServiceNow, perform workstream 2 from the parent session. The final ServiceNow work note must state: incidents linked and resolved (numbers), routes fixed, prevention control added, PR URL.',
].join('\n');

function memberNotFound() {
  const error = new Error('Member not found. Please verify the email address and member ID.');
  error.name = 'MemberNotFoundError';
  error.statusCode = 404;
  error.code = 'MEMBER_NOT_FOUND';
  return error;
}

/**
 * Resolve the plan benefits that govern a member's coverage status from the
 * plan the member is enrolled in.
 */
function resolvePlanBenefits(member) {
  return PLAN_CONFIG[member.planType];
}

/**
 * Resolve the plan used to price a visit. Members whose plan assignment has
 * not been mapped are priced at the network default.
 */
function resolveEstimatePlan(member) {
  const planType = member.planType || DEFAULT_PLAN;
  return { planType, ...PLAN_CONFIG[planType] };
}

/**
 * Summarize deductible, out-of-pocket and cost-share status for a member.
 */
function buildCoverageSummary(member, plan) {
  const deductibleMet = member.accumulators.deductibleMet;
  const deductibleRemaining = Math.max(0, plan.deductible - deductibleMet);
  const oopRemaining = Math.max(0, plan.oopMax - member.accumulators.oopMet);

  return {
    planName: plan.name,
    deductible: plan.deductible,
    deductibleMet,
    deductibleRemaining,
    deductiblePct: Math.min(100, Math.round((deductibleMet / plan.deductible) * 100)),
    oopMax: plan.oopMax,
    oopRemaining,
    copay: plan.copay,
    coinsurance: `${Math.round(plan.coinsurance * 100)}%`,
    claimsYTD: member.accumulators.claimsYTD,
  };
}

/**
 * Member cost for an in-network service under a plan, given what the member
 * has already accumulated toward the deductible and out-of-pocket maximum.
 */
function priceService(plan, accumulators, service) {
  if (service.preventive) {
    return { memberPays: 0, planPays: service.allowedAmount, basis: 'Preventive care — covered in full' };
  }

  const deductibleRemaining = Math.max(0, plan.deductible - accumulators.deductibleMet);
  const oopRemaining = Math.max(0, plan.oopMax - accumulators.oopMet);
  let memberPays;
  let basis;

  if (deductibleRemaining >= service.allowedAmount) {
    memberPays = service.allowedAmount;
    basis = `Applied to deductible ($${deductibleRemaining} remaining)`;
  } else if (deductibleRemaining > 0) {
    memberPays = deductibleRemaining + (service.allowedAmount - deductibleRemaining) * plan.coinsurance;
    basis = `$${deductibleRemaining} remaining deductible + ${Math.round(plan.coinsurance * 100)}% coinsurance`;
  } else if (service.copayApplies) {
    memberPays = plan.copay;
    basis = 'Deductible met — office visit copay';
  } else {
    memberPays = service.allowedAmount * plan.coinsurance;
    basis = `Deductible met — ${Math.round(plan.coinsurance * 100)}% coinsurance`;
  }

  memberPays = Math.min(Math.round(memberPays * 100) / 100, oopRemaining);
  return {
    memberPays,
    planPays: Math.round((service.allowedAmount - memberPays) * 100) / 100,
    basis,
  };
}

/**
 * Look up a member's coverage status, deductible progress and cost sharing.
 */
async function lookupCoverage(data) {
  const startTime = Date.now();
  const lookupId = uuidv4();
  const member = findMember(data);

  logger.info('Processing member coverage lookup', {
    lookupId,
    email: data.email,
    memberId: data.memberId,
    service: SERVICE,
    route: ROUTE,
  });

  if (!member) {
    throw memberNotFound();
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const plan = resolvePlanBenefits(member);
    const summary = buildCoverageSummary(member, plan);

    incrementMetric('coverage.lookup.success', {
      route: ROUTE,
      plan: member.enrollment.planType,
    });
    recordTiming('coverage.lookup.latency', Date.now() - startTime, {
      route: ROUTE,
      error: 'false',
    });

    return {
      success: true,
      lookupId,
      member: member.name,
      memberId: member.id,
      groupNumber: member.enrollment.groupNumber,
      effectiveDate: member.enrollment.effectiveDate,
      status: 'Active',
      ...summary,
      recentClaims: RECENT_CLAIMS,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('coverage.lookup.failure', {
      route: ROUTE,
      errorClass: error.name,
      memberId: member.id,
    });
    recordTiming('coverage.lookup.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Member coverage lookup failed', {
      lookupId,
      memberId: member.id,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        route: ROUTE,
        memberId: member.id,
        alert_path: 'instant',
      },
      extra: {
        lookupId,
        enrolledPlan: member.enrollment.planType,
        groupNumber: member.enrollment.groupNumber,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/7c6a6ef9.js \u2014 buildCoverageSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'enGen \u2014 Member Coverage Status',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '7c6a6ef9',
      slackMemberId: data.devinEmail ? '' : ONCALL_SLACK_MEMBER_ID,
      slackMemberIdFallback: ONCALL_SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'memberId', value: member.id },
      ],
      extra: {
        lookupId,
        enrolledPlan: member.enrollment.planType,
        groupNumber: member.enrollment.groupNumber,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
    }).catch((alertError) => {
      logger.error('Failed to post alert for member coverage lookup error', {
        lookupId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

/**
 * Estimate what a member will owe for an in-network service before the visit.
 */
async function estimateVisitCost(data) {
  const startTime = Date.now();
  const estimateId = uuidv4();
  const member = findMember(data);
  const service = findService(data.serviceId);

  logger.info('Processing visit cost estimate', {
    estimateId,
    email: data.email,
    memberId: data.memberId,
    serviceId: data.serviceId,
    service: SERVICE,
    route: ESTIMATE_ROUTE,
  });

  if (!member) {
    throw memberNotFound();
  }

  if (!service) {
    const error = new Error(`Unknown service: ${data.serviceId || '(none)'}`);
    error.name = 'ValidationError';
    error.statusCode = 400;
    error.code = 'UNKNOWN_SERVICE';
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const plan = resolveEstimatePlan(member);
    const price = priceService(plan, member.accumulators, service);
    const deductibleRemaining = Math.max(0, plan.deductible - member.accumulators.deductibleMet);

    incrementMetric('cost_estimate.quoted', {
      route: ESTIMATE_ROUTE,
      plan: plan.planType,
      serviceId: service.id,
      memberId: member.id,
    });
    recordTiming('cost_estimate.latency', Date.now() - startTime, {
      route: ESTIMATE_ROUTE,
      error: 'false',
    });

    logger.info('Visit cost estimate quoted', {
      estimateId,
      memberId: member.id,
      plan: plan.planType,
      serviceId: service.id,
      memberPays: price.memberPays,
    });

    return {
      success: true,
      estimateId,
      status: 'quoted',
      member: member.name,
      memberId: member.id,
      planName: plan.name,
      planType: plan.planType,
      service: service.label,
      allowedAmount: service.allowedAmount,
      memberPays: price.memberPays,
      planPays: price.planPays,
      basis: price.basis,
      deductibleRemaining,
      deductibleMet: deductibleRemaining === 0,
      quotedAt: new Date().toISOString(),
    };
  } catch (error) {
    recordTiming('cost_estimate.latency', Date.now() - startTime, {
      route: ESTIMATE_ROUTE,
      error: 'true',
    });

    logger.error('Visit cost estimate failed', {
      estimateId,
      memberId: member.id,
      serviceId: service.id,
      error: error.message,
      errorClass: error.name,
      durationMs: Date.now() - startTime,
      service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        route: ESTIMATE_ROUTE,
        memberId: member.id,
      },
      extra: {
        estimateId,
        serviceId: service.id,
        enrolledPlan: member.enrollment.planType,
      },
    });
    throw error;
  }
}

module.exports = {
  lookupCoverage,
  estimateVisitCost,
  MEMBERS,
  SERVICES,
  RECENT_CLAIMS,
};
