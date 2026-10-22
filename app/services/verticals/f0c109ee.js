const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-f0c109ee-claims-intake';
const ROUTE = '/api/f0c109ee/claims';
const PAGE = '/f0c109ee';

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the group benefits claim submission vertical:',
  '- Service: `app/services/verticals/f0c109ee.js`',
  '- Route: `app/routes/verticals/f0c109ee.js`',
  '- Page: `app/public/verticals/f0c109ee.html` (served at `/f0c109ee`)',
  '',
  'Start from the coverage line built for the claim and work back through the',
  'eligibility record it is built from.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MEMBER = {
  memberId: 'MBR-7731904',
  name: 'Jamie Rivera',
  employer: 'Northwind Logistics',
  groupNumber: '0451',
};

const POLICIES = {
  'POL-5004': {
    claimType: 'dental',
    planName: 'Group Dental PPO',
    coverageTier: 'family',
    status: 'active',
  },
  'POL-5002': {
    claimType: 'disability',
    planName: 'Short-Term Disability',
    coverageTier: 'employee',
    status: 'active',
  },
  'POL-5003': {
    claimType: 'life',
    planName: 'Basic Group Life',
    coverageTier: 'employee',
    status: 'active',
  },
};

const ELIGIBILITY_FEED = {
  'POL-5004': {
    memberId: MEMBER.memberId,
    groupNumber: MEMBER.groupNumber,
    planYear: 2026,
    coverageTier: 'family',
    benefitSchedule: {
      tiers: {
        employee: {
          annualMax: 1500,
          categories: {
            preventive: { coinsurance: 1.0 },
            basic: { coinsurance: 0.8 },
            major: { coinsurance: 0.5 },
          },
        },
        family: {
          annualMax: 2000,
          categories: {
            preventive: { coinsurance: 1.0 },
            basic: { coinsurance: 0.8 },
            major: { coinsurance: 0.5 },
          },
        },
      },
    },
    accumulators: { used: 310 },
  },
  'POL-5002': {
    memberId: MEMBER.memberId,
    groupNumber: MEMBER.groupNumber,
    planYear: 2026,
    coverageTier: 'employee',
    benefitSchedule: {
      tiers: {
        employee: {
          annualMax: 26000,
          categories: {
            short_term: { coinsurance: 0.6 },
          },
        },
      },
    },
    accumulators: { used: 0 },
  },
  'POL-5003': {
    memberId: MEMBER.memberId,
    groupNumber: MEMBER.groupNumber,
    planYear: 2026,
    coverageTier: 'employee',
    benefitSchedule: {
      tiers: {
        employee: {
          annualMax: 100000,
          categories: {
            basic_life: { coinsurance: 1.0 },
          },
        },
      },
    },
    accumulators: { used: 0 },
  },
};

const CATEGORY_KEYWORDS = {
  dental: [
    { category: 'major', keywords: ['crown', 'bridge', 'implant', 'denture', 'root canal'] },
    { category: 'basic', keywords: ['filling', 'extraction', 'periodontal'] },
    { category: 'preventive', keywords: ['exam', 'cleaning', 'x-ray'] },
  ],
  disability: [{ category: 'short_term', keywords: [] }],
  life: [{ category: 'basic_life', keywords: [] }],
};

function validateClaim(data) {
  const policy = POLICIES[data.policyId];
  if (!policy) throw new ValidationError('We couldn\u2019t find that coverage on your account.');
  if (policy.status !== 'active') throw new ValidationError('That coverage is not active.');
  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new ValidationError('Enter the amount you are claiming.');
  if (!data.serviceDate) throw new ValidationError('Enter the date of service or event.');
  return {
    policyId: data.policyId,
    claimType: policy.claimType,
    amount,
    description: String(data.description || '').trim(),
    serviceDate: data.serviceDate,
  };
}

function categorizeClaim(claim) {
  const rules = CATEGORY_KEYWORDS[claim.claimType] || [];
  const text = claim.description.toLowerCase();
  const match = rules.find((rule) => rule.keywords.some((keyword) => text.includes(keyword)));
  return (match || rules[rules.length - 1] || {}).category;
}

async function fetchEligibility(policyId) {
  await new Promise((resolve) => { setTimeout(resolve, 120); });
  const record = ELIGIBILITY_FEED[policyId];
  if (!record) throw new ValidationError('Eligibility could not be confirmed for this coverage.');
  return record;
}

function toCoverageLine(policyId, record) {
  return {
    policyId,
    planName: POLICIES[policyId].planName,
    planYear: record.planYear,
    tier: record.coverageTier,
    schedule: record.benefits,
    accumulators: record.accumulators,
  };
}

function calculateBenefit(line, claim) {
  const rule = line.schedule.categories[claim.category];
  const remaining = Math.max(0, line.schedule.annualMax - line.accumulators.used);
  const allowed = Math.min(claim.amount, remaining);
  return {
    allowed,
    coinsurance: rule.coinsurance,
    payout: Math.round(allowed * rule.coinsurance * 100) / 100,
    remainingAfter: remaining - allowed,
  };
}

async function submitClaim(data, { shouldAlert = () => true } = {}) {
  const claimId = uuidv4();
  const startTime = Date.now();
  let claim;

  try {
    claim = validateClaim(data);
  } catch (error) {
    error.claimId = claimId;
    throw error;
  }

  try {
    claim.category = categorizeClaim(claim);
    const record = await fetchEligibility(claim.policyId);
    const line = toCoverageLine(claim.policyId, record);
    const benefit = calculateBenefit(line, claim);
    const duration = Date.now() - startTime;

    incrementMetric('f0c109ee_claim.success', { route: ROUTE, claimType: claim.claimType });
    recordTiming('f0c109ee_claim.latency', duration, { route: ROUTE });
    logger.info('Benefits claim submitted', {
      claimId, claimType: claim.claimType, category: claim.category, durationMs: duration,
    });

    return {
      success: true,
      claimId,
      claimType: claim.claimType,
      category: claim.category,
      planName: line.planName,
      payout: benefit.payout,
      allowed: benefit.allowed,
      remainingAfter: benefit.remainingAfter,
      status: 'received',
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('f0c109ee_claim.failure', {
      route: ROUTE, errorClass: error.name, claimType: claim.claimType,
    });
    recordTiming('f0c109ee_claim.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Benefits claim submission failed', {
      claimId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      policyId: claim.policyId,
      claimType: claim.claimType,
      category: claim.category,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, claimType: claim.claimType, page: PAGE,
      },
      extra: {
        claimId, policyId: claim.policyId, amount: claim.amount, category: claim.category,
      },
    });

    if (shouldAlert()) createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f0c109ee.js — calculateBenefit',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Group Benefits — File a claim',
      customer: 'f0c109ee',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'claimType', value: claim.claimType },
        { key: 'page', value: PAGE },
      ],
      extra: {
        claimId, policyId: claim.policyId, amount: claim.amount, category: claim.category,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'mybenefits-claims@1.1.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from benefits claim error', { error: err.message });
    });

    error.claimId = claimId;
    throw error;
  }
}

module.exports = {
  submitClaim,
  ValidationError,
  MEMBER,
  POLICIES,
};
