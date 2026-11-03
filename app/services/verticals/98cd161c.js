/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.MODERNFI_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-98cd161c-source-order';
const ROUTE = '/api/98cd161c/source-order';

const LATENCY_SLO = { budgetMs: 3000 };
const MEMBER_QUOTE_POLICY = { latencyMs: [450, 550] };
const NETWORK_RATE_PCT = 3.64;

const NETWORK_MEMBERS = {
  m01: { label: 'Western regional bank', assetsLabel: '$8B assets', state: 'AZ', network: 'NBID', capacityCents: 500000000 },
  m02: { label: 'Community bank', assetsLabel: '$1.2B assets', state: 'MO', network: 'NBID', capacityCents: 500000000 },
  m03: { label: 'Mid-Atlantic bank', assetsLabel: '$3.6B assets', state: 'VA', network: 'NBID', capacityCents: 500000000 },
  m04: { label: 'Gulf Coast community bank', assetsLabel: '$2.4B assets', state: 'TX', network: 'NBID', capacityCents: 500000000 },
  m05: { label: 'Great Lakes credit union', assetsLabel: '$2.1B assets', state: 'MI', network: 'CUSO', capacityCents: 600000000 },
  m06: { label: 'Mountain West bank', assetsLabel: '$5.2B assets', state: 'CO', network: 'NBID', capacityCents: 600000000 },
  m07: { label: 'New England savings bank', assetsLabel: '$4.8B assets', state: 'MA', network: 'NBID', capacityCents: 600000000 },
  m08: { label: 'Pacific Northwest credit union', assetsLabel: '$3.1B assets', state: 'WA', network: 'CUSO', capacityCents: 600000000 },
  m09: { label: 'Plains agricultural bank', assetsLabel: '$2.7B assets', state: 'KS', network: 'NBID', capacityCents: 700000000 },
  m10: { label: 'Southeast regional bank', assetsLabel: '$9.4B assets', state: 'GA', network: 'NBID', capacityCents: 700000000 },
  m11: { label: 'Ohio Valley community bank', assetsLabel: '$1.9B assets', state: 'OH', network: 'NBID', capacityCents: 800000000 },
  m12: { label: 'Desert Southwest credit union', assetsLabel: '$1.6B assets', state: 'NM', network: 'CUSO', capacityCents: 1000000000 },
  m13: { label: 'Upper Midwest bank', assetsLabel: '$6.8B assets', state: 'MN', network: 'NBID', capacityCents: 1200000000 },
  m14: { label: 'Carolinas community bank', assetsLabel: '$2.2B assets', state: 'NC', network: 'NBID', capacityCents: 1800000000 },
};

const ALL_MEMBERS = Object.keys(NETWORK_MEMBERS);

const SOURCE_SCOPES = {
  all: { label: `All network members (${ALL_MEMBERS.length})`, members: ALL_MEMBERS },
  ...Object.fromEntries(ALL_MEMBERS.map((key) => [
    key,
    { label: `${NETWORK_MEMBERS[key].label} · ${NETWORK_MEMBERS[key].state}`, members: [key] },
  ])),
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the ModernFi Source Deposits source-order request:',
  '- Service: `app/services/verticals/98cd161c.js`',
  '- Route: `app/routes/verticals/98cd161c.js`',
  '- Page: `app/public/verticals/98cd161c.html` (served at `/modernfi`)',
  '- Test: `tests/98cd161c-source-order.test.js`',
  '',
  'The default "All network members" Source order succeeds but takes ~7s versus the 3000ms latency budget.',
  'The culprit is `allocateAcrossNetwork` in the service.',
  'Fix the latency without raising or removing the latency budget, the breach alert, or the simulated per-member quote latency.',
  'Preserve the response payload, allocation order, and summary totals.',
  'Run `npx jest tests/98cd161c-source-order.test.js --runInBand` and `npm run lint`.',
  'Verify the default order at `/modernfi` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashLedger(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function quoteMemberLiquidity(institution, memberKey, targetCents) {
  void targetCents;
  const [min, max] = MEMBER_QUOTE_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const member = NETWORK_MEMBERS[memberKey];
  const hash = hashLedger(`${institution.toLowerCase()}:${memberKey}`);
  const offeredPct = 60 + (hash % 41);
  const offeredCents = Math.round((member.capacityCents * offeredPct / 100) / 100000) * 100000;

  return {
    member: memberKey,
    label: member.label,
    assetsLabel: member.assetsLabel,
    state: member.state,
    network: member.network,
    offeredCents,
  };
}

/**
 * Quotes are returned in network settlement order so the allocation ladder matches the portal.
 */
async function allocateAcrossNetwork(institution, targetCents, members) {
  const quotes = [];
  for (const memberKey of members) {
    quotes.push(await quoteMemberLiquidity(institution, memberKey, targetCents));
  }

  let remainingCents = targetCents;
  return quotes.map((quote) => {
    const allocatedCents = Math.min(quote.offeredCents, remainingCents);
    remainingCents -= allocatedCents;
    return {
      ...quote,
      allocatedCents,
      status: allocatedCents > 0 ? 'settled' : 'standby',
    };
  });
}

function validationError(message, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = 'INVALID_SOURCE_ORDER';
  error.requestId = requestId;
  return error;
}

function validateSourceOrder(data, requestId) {
  if (typeof data.institution !== 'string' || data.institution.trim().length === 0 || data.institution.trim().length > 80) {
    throw validationError('Enter an institution name (1–80 characters).', requestId);
  }
  if (typeof data.targetBalance !== 'number'
    || !Number.isInteger(data.targetBalance)
    || data.targetBalance < 1000000
    || data.targetBalance > 250000000) {
    throw validationError('Enter a whole-dollar target balance between $1,000,000 and $250,000,000.', requestId);
  }
  if (!Object.hasOwn(SOURCE_SCOPES, data.scope)) {
    throw validationError('Choose a valid network member scope.', requestId);
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, membersQuoted, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      membersQuoted,
      institution: data.institution,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/98cd161c.js — allocateAcrossNetwork',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'ModernFi Source Deposits',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '98cd161c',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      membersQuoted,
      datadogMetric: 'source_order.latency',
    },
    level: 'warning',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for ModernFi source-order latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runSourceOrder({
  institution,
  targetBalance,
  scope = 'all',
  devinUserId,
  devinOrgId,
  devinEmail,
} = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const normalized = {
    institution: typeof institution === 'string' ? institution.trim() : institution,
    targetBalance,
    scope: typeof scope === 'string' ? scope.trim().toLowerCase() : scope,
    devinUserId,
    devinOrgId,
    devinEmail,
  };

  validateSourceOrder(normalized, requestId);

  const selectedScope = SOURCE_SCOPES[normalized.scope];
  const targetBalanceCents = normalized.targetBalance * 100;
  const allocations = await allocateAcrossNetwork(
    normalized.institution,
    targetBalanceCents,
    selectedScope.members,
  );
  const fundedCents = allocations.reduce((sum, allocation) => sum + allocation.allocatedCents, 0);
  const remainingCents = Math.max(0, targetBalanceCents - fundedCents);
  const latencyMs = Date.now() - startTime;
  const summary = {
    membersQuoted: allocations.length,
    membersAllocated: allocations.filter((allocation) => allocation.allocatedCents > 0).length,
    fundedCents,
    fundedPct: Math.round((fundedCents / targetBalanceCents) * 1000) / 10,
    remainingCents,
    collateral: 'None',
    settlementCycle: 'Daily',
  };

  incrementMetric('source_order.success', {
    route: ROUTE,
    scope: normalized.scope,
  });
  recordTiming('source_order.latency', latencyMs, {
    route: ROUTE,
    scope: normalized.scope,
  });

  if (latencyMs > LATENCY_SLO.budgetMs) {
    incrementMetric('source_order.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
    });
    logger.warn('ModernFi source order exceeded latency budget', {
      requestId,
      latencyMs,
      budgetMs: LATENCY_SLO.budgetMs,
      membersQuoted: allocations.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    logger.warn('ModernFi source-order latency breach — triggering Devin session', {
      requestId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs: latencyMs,
      budgetMs: LATENCY_SLO.budgetMs,
      membersQuoted: allocations.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    requestId,
    institution: normalized.institution,
    scope: normalized.scope,
    scopeLabel: selectedScope.label,
    targetBalanceCents,
    networkRatePct: NETWORK_RATE_PCT,
    allocations,
    summary,
    latencyMs,
    latencyBudgetMs: LATENCY_SLO.budgetMs,
  };
}

module.exports = {
  runSourceOrder,
  NETWORK_MEMBERS,
  SOURCE_SCOPES,
  LATENCY_SLO,
  MEMBER_QUOTE_POLICY,
  NETWORK_RATE_PCT,
  allocateAcrossNetwork,
};
