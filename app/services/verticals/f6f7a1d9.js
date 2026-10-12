/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-f6f7a1d9-audience-reach';
const ROUTE = '/api/f6f7a1d9/audience-reach';
const SLACK_MEMBER_ID = process.env.CLARITAS_SLACK_MEMBER_ID || '';

const LATENCY_SLO = { budgetMs: 3000 };
const PARTNER_MATCH_POLICY = { latencyMs: [450, 550] };

const PARTNERS = [
  { key: 'liveramp', label: 'LiveRamp', channel: 'Identity onboarding', matchRate: [0.68, 0.82], devicesPerHousehold: [1.8, 2.8] },
  { key: 'thetradedesk', label: 'The Trade Desk', channel: 'Programmatic display/CTV', matchRate: [0.52, 0.72], devicesPerHousehold: [1.6, 2.5] },
  { key: 'google', label: 'Google Display & Video 360', channel: 'Programmatic display', matchRate: [0.58, 0.78], devicesPerHousehold: [1.7, 2.6] },
  { key: 'meta', label: 'Meta', channel: 'Social', matchRate: [0.62, 0.8], devicesPerHousehold: [1.6, 2.5] },
  { key: 'mediamath', label: 'MediaMath', channel: 'Programmatic display', matchRate: [0.48, 0.68], devicesPerHousehold: [1.5, 2.4] },
  { key: 'oracle', label: 'Oracle Advertising', channel: 'Data marketplace', matchRate: [0.5, 0.7], devicesPerHousehold: [1.5, 2.3] },
  { key: 'adobe', label: 'Adobe Audience Manager', channel: 'DMP', matchRate: [0.54, 0.74], devicesPerHousehold: [1.6, 2.5] },
  { key: 'salesforce', label: 'Salesforce Marketing Cloud', channel: 'CRM/email', matchRate: [0.46, 0.66], devicesPerHousehold: [1.2, 2] },
  { key: 'xandr', label: 'Xandr (AppNexus)', channel: 'Programmatic display', matchRate: [0.48, 0.69], devicesPerHousehold: [1.5, 2.4] },
  { key: 'pushspring', label: 'PushSpring', channel: 'Mobile app', matchRate: [0.42, 0.62], devicesPerHousehold: [1.3, 2.2] },
  { key: 'adtheorent', label: 'AdTheorent', channel: 'Mobile/display', matchRate: [0.44, 0.64], devicesPerHousehold: [1.4, 2.3] },
  { key: 'claritas_email', label: 'Claritas Email', channel: 'Email', matchRate: [0.56, 0.76], devicesPerHousehold: [1, 1.3] },
  { key: 'claritas_mail', label: 'Claritas Direct Mail', channel: 'Direct mail', matchRate: [0.38, 0.58], devicesPerHousehold: [1, 1.2] },
  { key: 'claritas_ctv', label: 'Claritas CTV', channel: 'Connected TV', matchRate: [0.5, 0.7], devicesPerHousehold: [1.5, 2.4] },
];

const CHANNEL_SCOPES = {
  all: { label: 'All activation partners', partners: PARTNERS.map((partner) => partner.key) },
  liveramp: { label: 'LiveRamp only', partners: ['liveramp'] },
  thetradedesk: { label: 'The Trade Desk only', partners: ['thetradedesk'] },
  claritas_email: { label: 'Claritas Email only', partners: ['claritas_email'] },
};

const SEGMENTS = [
  { key: 'prizm_01', code: '01', label: 'Upper Crust', householdShare: 0.0125 },
  { key: 'prizm_04', code: '04', label: 'Young Digerati', householdShare: 0.0118 },
  { key: 'prizm_07', code: '07', label: 'Money & Brains', householdShare: 0.0131 },
  { key: 'prizm_15', code: '15', label: 'Pools & Patios', householdShare: 0.0142 },
  { key: 'prizm_29', code: '29', label: 'American Dreams', householdShare: 0.0156 },
  { key: 'prizm_35', code: '35', label: 'Boomtown Singles', householdShare: 0.0109 },
];

const MARKETS = [
  { key: 'national', label: 'National (all U.S. DMAs)', households: 125100000 },
  { key: 'new_york', label: 'New York', households: 7726580 },
  { key: 'los_angeles', label: 'Los Angeles', households: 5838420 },
  { key: 'chicago', label: 'Chicago', households: 3490180 },
  { key: 'dallas', label: 'Dallas-Ft. Worth', households: 3108410 },
  { key: 'atlanta', label: 'Atlanta', households: 2652690 },
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Claritas AudienceAnywhere audience reach estimate:',
  '- Service: `app/services/verticals/f6f7a1d9.js`',
  '- Route: `app/routes/verticals/f6f7a1d9.js`',
  '- Page: `app/public/verticals/f6f7a1d9.html` (served at `/claritas`)',
  '- Test: `tests/f6f7a1d9-audience-reach.test.js`',
  '',
  'Audience reach estimates using the default "All activation partners" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `collectPartnerMatchCounts`. Do not raise or remove the latency budget, the breach alert, or the simulated per-partner match latency.',
  'Preserve the response payload for every channel scope, including partner order in `partners` (network directory order).',
  'Run `npx jest tests/f6f7a1d9-audience-reach.test.js` and `npm run lint`.',
  'Verify the default estimate at `/claritas` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashValue(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

async function matchPartnerAudience(partnerKey, request, segmentHouseholds) {
  const [minLatency, maxLatency] = PARTNER_MATCH_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, minLatency + Math.random() * (maxLatency - minLatency)));

  const partner = PARTNERS.find((entry) => entry.key === partnerKey);
  const seed = hashValue(`${request.segment}:${request.market}:${partnerKey}`);
  const matchRate = round3(partner.matchRate[0] + ((seed % 10001) / 10000) * (partner.matchRate[1] - partner.matchRate[0]));
  const deviceSeed = hashValue(`${request.segment}:${request.market}:${partnerKey}:devices`);
  const devicesPerHousehold = partner.devicesPerHousehold[0]
    + ((deviceSeed % 10001) / 10000) * (partner.devicesPerHousehold[1] - partner.devicesPerHousehold[0]);
  const matchedHouseholds = Math.round(segmentHouseholds * matchRate);

  return {
    partnerKey,
    partner: partner.label,
    channel: partner.channel,
    matchRate,
    matchedHouseholds,
    matchedDevices: Math.round(matchedHouseholds * devicesPerHousehold),
    status: 'ready',
  };
}

/**
 * Match the audience against each activation partner in scope, in network directory order.
 */
async function collectPartnerMatchCounts(partnerKeys, request, segmentHouseholds) {
  const results = [];
  for (const key of partnerKeys) results.push(await matchPartnerAudience(key, request, segmentHouseholds));
  return results;
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeRequest(data) {
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    company: typeof requestData.company === 'string' ? requestData.company.trim() : '',
    email: typeof requestData.email === 'string' ? requestData.email.trim().toLowerCase() : '',
    segment: String(requestData.segment === undefined ? 'prizm_04' : requestData.segment).trim().toLowerCase(),
    market: String(requestData.market === undefined ? 'national' : requestData.market).trim().toLowerCase(),
    channels: String(requestData.channels === undefined ? 'all' : requestData.channels).trim().toLowerCase(),
  };

  if (normalized.company.length < 2 || normalized.company.length > 80) {
    throw validationError('Enter your company name (2–80 characters).', 'COMPANY_INVALID');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
    throw validationError('Enter a valid email address.', 'EMAIL_INVALID');
  }
  if (!SEGMENTS.some((entry) => entry.key === normalized.segment)
    || !MARKETS.some((entry) => entry.key === normalized.market)
    || !Object.hasOwn(CHANNEL_SCOPES, normalized.channels)) {
    throw validationError('Choose a valid segment, market, and activation channel scope.', 'SELECTION_INVALID');
  }

  return normalized;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, partnersQueried, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      segment: data.segment,
      market: data.market,
      channels: data.channels,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      partnersQueried,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/f6f7a1d9.js — collectPartnerMatchCounts',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Claritas AudienceAnywhere Reach Estimate',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'f6f7a1d9',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'segment', value: data.segment },
      { key: 'market', value: data.market },
      { key: 'channels', value: data.channels },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      partnersQueried,
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
    logger.error('Failed to create Devin session for Claritas audience-reach latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function estimateAudienceReach(data = {}) {
  const startTime = Date.now();
  const requestId = `CL-${uuidv4().slice(0, 8).toUpperCase()}`;
  let normalized;
  try {
    normalized = normalizeRequest(data);
  } catch (error) {
    error.requestId = requestId;
    throw error;
  }

  const segment = SEGMENTS.find((entry) => entry.key === normalized.segment);
  const market = MARKETS.find((entry) => entry.key === normalized.market);
  const channelScope = CHANNEL_SCOPES[normalized.channels];
  const segmentHouseholds = Math.round(
    market.households
      * segment.householdShare
      * (0.92 + (hashValue(`${normalized.segment}:${normalized.market}`) % 1600) / 10000),
  );

  logger.info('Estimating AudienceAnywhere audience reach', {
    requestId,
    segment: normalized.segment,
    market: normalized.market,
    channels: normalized.channels,
    service: SERVICE,
    route: ROUTE,
  });

  const partners = await collectPartnerMatchCounts(channelScope.partners, normalized, segmentHouseholds);
  const durationMs = Date.now() - startTime;
  const maxMatchedHouseholds = Math.max(...partners.map((partner) => partner.matchedHouseholds));
  const combinedReachRate = 1 - partners.reduce((remaining, partner) => remaining * (1 - 0.6 * partner.matchRate), 1);
  const uniqueReachableHouseholds = Math.min(
    segmentHouseholds,
    Math.max(maxMatchedHouseholds, Math.round(segmentHouseholds * combinedReachRate)),
  );
  const totalMatchedDevices = partners.reduce((sum, partner) => sum + partner.matchedDevices, 0);

  incrementMetric('audience_reach.success', {
    route: ROUTE,
    segment: normalized.segment,
    market: normalized.market,
    channels: normalized.channels,
  });
  recordTiming('audience_reach.latency', durationMs, { route: ROUTE });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('audience_reach.latency_budget_breach', {
      route: ROUTE,
      segment: normalized.segment,
      market: normalized.market,
      channels: normalized.channels,
    });
    logger.warn('Claritas AudienceAnywhere reach estimate exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      partnersQueried: channelScope.partners.length,
      segment: normalized.segment,
      market: normalized.market,
      channels: normalized.channels,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      partnersQueried: channelScope.partners.length,
      data: {
        ...normalized,
        devinUserId: data.devinUserId,
        devinOrgId: data.devinOrgId,
        devinEmail: data.devinEmail,
      },
    }));
  }

  return {
    success: true,
    requestId,
    company: normalized.company,
    segment: { key: segment.key, code: segment.code, label: segment.label },
    market: { key: market.key, label: market.label },
    channels: { key: normalized.channels, label: channelScope.label },
    segmentHouseholds,
    partnersQueried: partners.length,
    uniqueReachableHouseholds,
    totalMatchedDevices,
    partners,
    durationMs,
  };
}

module.exports = {
  estimateAudienceReach,
  PARTNERS,
  CHANNEL_SCOPES,
  SEGMENTS,
  MARKETS,
  PARTNER_MATCH_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
