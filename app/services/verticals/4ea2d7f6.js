/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { claimLatencyAlert, releaseLatencyAlert } = require('../latency-alert-cooldown');

const SLACK_MEMBER_ID = process.env.SHIELD_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-4ea2d7f6-surveillance-sweep';
const ROUTE = '/api/4ea2d7f6/surveillance-sweep';

const LATENCY_SLO = { budgetMs: 3000 };
const CHANNEL_CAPTURE_POLICY = { latencyMs: [450, 550] };

const DESKS = {
  rates: { label: 'Rates Trading', traders: 42 },
  fx: { label: 'FX Spot & Options', traders: 36 },
  equities: { label: 'Cash Equities', traders: 58 },
  commodities: { label: 'Energy & Commodities', traders: 24 },
};

const LOOKBACK_WINDOWS = {
  '24h': { label: 'Last 24 hours', days: 1 },
  '7d': { label: 'Last 7 days', days: 7 },
};

const CONNECTED_CHANNELS = [
  { key: 'email', label: 'Email (Exchange / Gmail)', type: 'eComms' },
  { key: 'bloomberg', label: 'Bloomberg IB Chat', type: 'eComms' },
  { key: 'teams', label: 'Microsoft Teams', type: 'eComms' },
  { key: 'whatsapp', label: 'WhatsApp', type: 'Mobile' },
  { key: 'zoom', label: 'Zoom', type: 'Video' },
  { key: 'symphony', label: 'Symphony', type: 'eComms' },
  { key: 'ice', label: 'ICE Chat', type: 'eComms' },
  { key: 'refinitiv', label: 'Refinitiv Messenger', type: 'eComms' },
  { key: 'verint', label: 'Verint Turret Voice', type: 'Voice' },
  { key: 'verba', label: 'Verba Recording', type: 'Voice' },
  { key: 'slack', label: 'Slack', type: 'eComms' },
  { key: 'linkedin', label: 'LinkedIn', type: 'Social' },
  { key: 'twitter', label: 'X (Twitter)', type: 'Social' },
  { key: 'office365', label: 'Office 365 Files', type: 'Files' },
];

function channelsFor(keys) {
  return keys.map((key) => CONNECTED_CHANNELS.find((channel) => channel.key === key));
}

const CHANNEL_SCOPES = {
  all: { label: 'All connected channels', channels: CONNECTED_CHANNELS },
  bloomberg: { label: 'Bloomberg IB Chat only', channels: channelsFor(['bloomberg']) },
  teams: { label: 'Microsoft Teams only', channels: channelsFor(['teams']) },
  whatsapp: { label: 'WhatsApp only', channels: channelsFor(['whatsapp']) },
  email: { label: 'Email only', channels: channelsFor(['email']) },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Shield communications surveillance sweep request:',
  '- Service: `app/services/verticals/4ea2d7f6.js`',
  '- Route: `app/routes/verticals/4ea2d7f6.js`',
  '- Page: `app/public/verticals/4ea2d7f6.html` (served at `/shield`)',
  '- Test: `tests/4ea2d7f6-surveillance-sweep.test.js`',
  '',
  'Surveillance sweeps with the default "All connected channels" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency (start with `collectChannelCaptures`) and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-channel capture latency.',
  'Preserve the response payload for every channel scope, including channel order and the highest-risk-channel tie-break.',
  'Run `npx jest tests/4ea2d7f6-surveillance-sweep.test.js --runInBand` and `npm run lint`.',
  'Verify the default sweep at `/shield` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashCapture(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function captureChannel(channel, desk, lookback) {
  const [min, max] = CHANNEL_CAPTURE_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const hash = hashCapture(`${desk}:${lookback}:${channel.key}`);
  const days = LOOKBACK_WINDOWS[lookback].days;
  const messagesCaptured = (DESKS[desk].traders * (40 + (hash % 160))) * days;
  const alertsRaised = Math.max(1, Math.round(messagesCaptured * 0.0015 * (((hash >>> 8) % 10) + 1) / 10));
  const truePositives = Math.min(alertsRaised, (hash >>> 4) % 3);

  return {
    channel: channel.key,
    label: channel.label,
    type: channel.type,
    messagesCaptured,
    alertsRaised,
    truePositives,
  };
}

/**
 * Pull captures from each connected channel in policy order;
 * selectHighestRisk breaks ties by that order.
 */
async function collectChannelCaptures(channels, desk, lookback) {
  const captures = [];
  for (const channel of channels) {
    captures.push(await captureChannel(channel, desk, lookback));
  }
  return captures;
}

function selectHighestRisk(captures) {
  return captures.reduce((best, capture) => {
    if (!best) return capture;
    if (capture.truePositives > best.truePositives) return capture;
    if (capture.truePositives === best.truePositives && capture.alertsRaised > best.alertsRaised) return capture;
    return best;
  }, null);
}

function validateSweepRequest(data) {
  const validDesk = Object.hasOwn(DESKS, data.desk);
  const validScope = Object.hasOwn(CHANNEL_SCOPES, data.scope);
  const validLookback = Object.hasOwn(LOOKBACK_WINDOWS, data.lookback);

  if (!validDesk || !validScope || !validLookback) {
    const error = new Error('Choose a valid desk, channel scope and lookback window.');
    error.name = 'ValidationError';
    error.code = 'SWEEP_PARAMETERS_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, channelsSwept, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      desk: data.desk,
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      channelsSwept,
    },
  });

  if (!claimLatencyAlert('4ea2d7f6')) {
    logger.info('Shield Communications latency breach alert suppressed by cooldown', { requestId, durationMs });
    return;
  }

  Promise.resolve(createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/4ea2d7f6.js — collectChannelCaptures',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Shield Communications Surveillance Sweep',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '4ea2d7f6',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'desk', value: data.desk },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      channelsSwept,
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
  })).then((result) => {
    if (!result) releaseLatencyAlert('4ea2d7f6');
  }).catch((alertError) => {
    releaseLatencyAlert('4ea2d7f6');
    logger.error('Failed to create Devin session for Shield surveillance sweep latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runSurveillanceSweep(data = {}) {
  const startTime = Date.now();
  const sweepId = `SHD-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    desk: String(requestData.desk === undefined ? 'rates' : requestData.desk).trim().toLowerCase(),
    scope: String(requestData.scope === undefined ? 'all' : requestData.scope).trim().toLowerCase(),
    lookback: String(requestData.lookback === undefined ? '24h' : requestData.lookback).trim().toLowerCase(),
  };

  validateSweepRequest(normalized);

  const desk = DESKS[normalized.desk];
  const scope = CHANNEL_SCOPES[normalized.scope];
  const lookback = LOOKBACK_WINDOWS[normalized.lookback];

  logger.info('Running Shield surveillance sweep', {
    sweepId,
    desk: normalized.desk,
    scope: normalized.scope,
    lookback: normalized.lookback,
    service: SERVICE,
    route: ROUTE,
  });

  const captures = await collectChannelCaptures(scope.channels, normalized.desk, normalized.lookback);
  const highestRisk = selectHighestRisk(captures);
  const totals = captures.reduce((acc, capture) => ({
    messagesCaptured: acc.messagesCaptured + capture.messagesCaptured,
    alertsRaised: acc.alertsRaised + capture.alertsRaised,
    truePositives: acc.truePositives + capture.truePositives,
  }), { messagesCaptured: 0, alertsRaised: 0, truePositives: 0 });
  const alertRatePct = Math.round((totals.alertsRaised / totals.messagesCaptured) * 10000) / 100;
  const durationMs = Date.now() - startTime;

  incrementMetric('surveillance_sweep.success', {
    route: ROUTE,
    desk: normalized.desk,
    scope: normalized.scope,
  });
  recordTiming('surveillance_sweep.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('surveillance_sweep.latency_budget_breach', {
      route: ROUTE,
      desk: normalized.desk,
      scope: normalized.scope,
    });
    logger.warn('Shield surveillance sweep exceeded latency budget — triggering Devin', {
      sweepId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      channelsSwept: captures.length,
      desk: normalized.desk,
      scope: normalized.scope,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: sweepId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      channelsSwept: captures.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    sweepId,
    desk: { key: normalized.desk, label: desk.label },
    scope: { key: normalized.scope, label: scope.label },
    lookback: { key: normalized.lookback, label: lookback.label },
    channelsSwept: captures.length,
    captures,
    totals,
    alertRatePct,
    highestRiskChannel: highestRisk.channel,
    durationMs,
  };
}

module.exports = {
  runSurveillanceSweep,
  selectHighestRisk,
  DESKS,
  LOOKBACK_WINDOWS,
  CHANNEL_SCOPES,
  CONNECTED_CHANNELS,
  CHANNEL_CAPTURE_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
