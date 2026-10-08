const crypto = require('crypto');
const logger = require('../telemetry/logger');
const { ownerRotation, postMessage, postThreadReply, lookupSlackUserByEmail } = require('./slack');
const { buildTeamsAlertCard, postTeamsCard } = require('./teams');
const { createDevinSession } = require('./devin-api');
const { canCreateSession, reserveSession } = require('./session-rate-limiter');
const { scheduleVulnerablePR } = require('./sonar-pr-trigger');
const { getScenario, getOncallRunRef, setScopedScenario, clearScopedScenario, setScopedConfig, getScopedConfig, clearScopedConfig } = require('../incidentModes');
const { COMPLIANCE_CONFIG: COMPLIANCE_DEFAULTS } = require('./oncall-verticals/banking');

/**
 * On-Call demo service.
 *
 * Posts alert cards, support tickets, and incident bursts to the
 * dedicated On-Call Slack channels. Alert-only by default: the On-Call
 * responders listening to the channels pick the messages up on their own.
 * A skin may opt its own branded page into auto-triage with
 * devinSession: { auto: true }, which creates one Devin session per alert
 * that skin raises and replies with its link in the alert thread. Alerts
 * raised without such a skin never create a session.
 *
 * Channels/token are configurable via env:
 *   SLACK_ONCALL_ALERTS_CHANNEL_ID — alert + incident channel (#oncall-alerts)
 *   SLACK_ONCALL_BUGS_CHANNEL_ID   — bug report channel (#oncall-bugs)
 *   SLACK_ONCALL_ALERTS_CHANNEL_NAME / SLACK_ONCALL_BUGS_CHANNEL_NAME — labels the
 *     on-call ribbon shows after posting (default #oncall-alerts / #oncall-bugs)
 *   SLACK_ONCALL_BOT_TOKEN         — bot token override (default: SLACK_BOT_TOKEN)
 *   ONCALL_TEAMS_WEBHOOK_URL       — optional Teams Workflows webhook; alert cards
 *     from skins with `teamsAlerts: true` are also posted there as Adaptive Cards
 *   ONCALL_TEAMS_ALL_ALERTS=true   — post every alert card to that webhook, not
 *     only `teamsAlerts` skins
 */

const REPO_URL = process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin';
const DEMO_BASE_URL = () =>
  (process.env.ONCALL_DEMO_BASE_URL || `https://${process.env.DOMAIN_NAME || 'devindemos.com'}`).replace(/\/$/, '');

/**
 * Alert scenarios for the on-call vertical demos. Cards are metric-shaped —
 * symptom, monitor, threshold, release marker — with no code locations, so
 * the responder correlates the signal to the cause through telemetry and the
 * repository itself.
 */
const ALERT_SCENARIOS = {
  banking: {
    vertical: 'banking',
    page: 'banking.html',
    apiPath: '/api/banking/transfer',
    oncallApiPath: '/api/oncall/banking/transfer',
    owner: 'Jordan Patel (payments-oncall)',
    brand: 'Apex Bank (Online Banking)',
    service: 'banking-api',
    endpoint: 'POST /api/oncall/banking/transfer',
    monitor: 'p95 latency — POST /api/oncall/banking/transfer',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/banking/transfer}',
    metricValue: '9.6s',
    threshold: '> 1.5s',
    baseline: '~280ms (7-day p95)',
    release: 'apex-bank@1.0.3',
    symptom: 'Transfer submissions hang ~10s before completing. Error rate is normal — requests eventually succeed.',
    impact: 'Every outgoing transfer sits on a spinner for ~10 seconds; support is reporting rising complaint volume.',
  },
  insurance: {
    vertical: 'insurance',
    page: 'insurance.html',
    apiPath: '/api/insurance/claim',
    oncallApiPath: '/api/oncall/insurance/claim',
    owner: 'Morgan Lee (claims-platform-oncall)',
    brand: 'Shield Insurance (Claims Portal)',
    service: 'insurance-api',
    endpoint: 'POST /api/oncall/insurance/claim',
    monitor: '5xx rate — POST /api/oncall/insurance/claim',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/insurance/claim,http.status_code:504}',
    metricValue: '504 on ~100% of submissions',
    threshold: '> 5% error rate',
    baseline: '<0.5% (7-day)',
    release: 'shield-insurance@1.0.3',
    symptom: 'Claim submissions hang ~8s and then fail with 504 Gateway Timeout. Upstream adjudication latency is elevated.',
    impact: 'Policyholders cannot file claims through the portal; every submission times out after a long hang.',
  },
  hightech: {
    vertical: 'hightech',
    page: 'hightech.html',
    apiPath: '/api/licenses/provision',
    oncallApiPath: '/api/oncall/licenses/provision',
    owner: 'Sam Okafor (licensing-oncall)',
    brand: 'NovaSoft (License Management)',
    service: 'licensing-api',
    endpoint: 'POST /api/oncall/licenses/provision',
    monitor: 'p95 latency trending up — POST /api/oncall/licenses/provision',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/licenses/provision}',
    metricValue: '6.8s and climbing',
    threshold: '> 2s',
    baseline: '~350ms (7-day p95, before novasoft@1.0.3)',
    release: 'novasoft@1.0.3',
    symptom: 'Provisioning latency jumped after the last release and creeps higher with every request. Process RSS trends up alongside it.',
    impact: 'License provisioning is slow for every customer and getting slower under sustained traffic.',
    // Climbing-latency scenario: repeat submits demonstrate the per-request
    // growth, so retries within the window join the same incident.
    retryWindow: true,
  },
  voice: {
    vertical: 'voice',
    page: 'voice.html',
    apiPath: '/api/voice/transcribe',
    oncallApiPath: '/api/oncall/voice/transcribe',
    owner: 'Priya Nair (dictation-oncall)',
    brand: 'EchoScribe (Dictation Console)',
    service: 'dictation-api',
    endpoint: 'POST /api/oncall/voice/transcribe',
    monitor: 'p95 latency trending up — POST /api/oncall/voice/transcribe',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/voice/transcribe}',
    metricValue: '7.2s and climbing',
    threshold: '> 1.5s',
    baseline: '~240ms (7-day p95, before echoscribe@1.0.4)',
    release: 'echoscribe@1.0.4',
    symptom: 'Transcript finalization latency jumped after the last release and creeps higher with every utterance. Process RSS trends up alongside it. Error rate is normal.',
    impact: 'Every dictation waits several seconds for its polished transcript, and the wait grows under sustained use.',
    // Climbing-latency scenario: repeat submits demonstrate the per-utterance
    // growth, so retries within the window join the same incident.
    retryWindow: true,
  },
  inference: {
    vertical: 'inference',
    page: 'inference.html',
    apiPath: '/api/inference/completions',
    oncallApiPath: '/api/oncall/inference/completions',
    owner: 'Dana Whitfield (serving-platform-oncall)',
    brand: 'Helix Serve (Inference Console)',
    service: 'inference-gateway',
    endpoint: 'POST /api/oncall/inference/completions',
    monitor: 'p95 time to first token trending up — POST /api/oncall/inference/completions',
    metricQuery: 'p95:demo.inference.ttft{service:checkout-api,route:/api/oncall/inference/completions}',
    metricValue: '6.4s TTFT and climbing',
    threshold: '> 1.5s',
    baseline: '~310ms (7-day p95 TTFT, before helix-serve@1.0.4)',
    release: 'helix-serve@1.0.4',
    symptom: 'Time to first token jumped after the last release and creeps higher with every completion served. Inter-token latency is unchanged and error rate is normal. Process RSS trends up alongside TTFT.',
    impact: 'Every completion waits several seconds before the first token, and the wait grows under sustained traffic. Streaming clients look hung.',
    // Climbing-latency scenario: repeat completions demonstrate the
    // per-request growth, so retries within the window join the same incident.
    retryWindow: true,
  },
  telco: {
    vertical: 'telco',
    page: 'telco.html',
    apiPath: '/api/telco/upgrade',
    oncallApiPath: '/api/oncall/telco/upgrade',
    owner: 'Riley Chen (subscriber-services-oncall)',
    brand: 'WaveConnect (Self-Service Portal)',
    service: 'telco-api',
    endpoint: 'POST /api/oncall/telco/upgrade',
    monitor: 'p95 latency — POST /api/oncall/telco/upgrade',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/telco/upgrade}',
    metricValue: '7.9s',
    threshold: '> 1.5s',
    baseline: '~300ms before the plan-catalog refresh',
    release: 'waveconnect@1.0.3',
    symptom: 'Plan upgrades slowed sharply after the plan-catalog refresh added the legacy/regional plans. Latency scales with catalog size.',
    impact: 'Subscribers wait ~8 seconds on every plan change; upgrade completion rate is dropping.',
  },
  marketplace: {
    vertical: 'marketplace',
    page: '63dbb52f.html',
    apiPath: '/api/marketplace/cart',
    oncallApiPath: '/api/oncall/marketplace/cart',
    owner: 'Nina Brandt (marketplace-checkout-oncall)',
    brand: 'Marktplatz Storefront (Product Detail)',
    service: 'cart-api',
    endpoint: 'POST /api/oncall/marketplace/cart',
    monitor: '5xx rate — POST /api/oncall/marketplace/cart',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/marketplace/cart,http.status_code:504}',
    metricValue: '504 on ~100% of add-to-cart requests',
    threshold: '> 5% error rate',
    baseline: '<0.4% (7-day)',
    release: 'marketplace-storefront@1.0.4',
    symptom: 'Add-to-cart requests hang ~8s and then fail with 504 Gateway Timeout. Stock reservation latency against the seller inventory partner is elevated.',
    impact: 'Shoppers cannot add marketplace offers to the basket; every add sits on a spinner and then errors.',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  apparel: {
    vertical: 'apparel',
    page: '0d1ff688.html',
    apiPath: '/api/apparel/bag',
    oncallApiPath: '/api/oncall/apparel/bag',
    owner: 'Dana Whitfield (bag-checkout-oncall)',
    brand: 'Department Store (Product Detail)',
    service: 'bag-api',
    endpoint: 'POST /api/oncall/apparel/bag',
    monitor: '5xx rate — POST /api/oncall/apparel/bag',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/apparel/bag,http.status_code:500}',
    metricValue: '500 on ~100% of add-to-bag requests',
    threshold: '> 2% error rate',
    baseline: '<0.2% (7-day)',
    release: 'pdp-web@2.14.0',
    symptom: 'Add to Bag fails immediately with HTTP 500 (TypeError in bag-api). Latency is normal. Onset coincides with the pdp-web 2.14.0 size-picker release.',
    impact: 'Shoppers cannot add apparel to their Bag; every Add to Bag errors right after a size is picked.',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  grocery: {
    vertical: 'grocery',
    page: 'e2d82a44.html',
    apiPath: '/api/grocery/checkout',
    oncallApiPath: '/api/oncall/grocery/checkout',
    owner: 'Maya Chen (online-grocery-checkout-oncall)',
    brand: 'PC Express (Grocery Checkout)',
    service: 'order-api',
    endpoint: 'POST /api/oncall/grocery/checkout',
    monitor: '5xx rate — POST /api/oncall/grocery/checkout',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/grocery/checkout,http.status_code:500}',
    metricValue: '500 on ~100% of checkout submissions',
    threshold: '> 2% error rate',
    baseline: '<0.3% (7-day)',
    release: 'pcx-checkout@1.0.6',
    symptom: 'Checkout submissions fail immediately with HTTP 500 during order-total calculation. Latency is normal. Onset coincides with the weekly PC Optimum offer catalog refresh.',
    impact: 'Shoppers cannot complete PC Express pickup orders; every checkout attempt errors before reaching payment.',
    // Branded page only: the storefront card is not offered on the generic hub.
    unlisted: true,
  },
  industrials: {
    vertical: 'industrials',
    page: 'industrials-quote.html',
    apiPath: '/api/industrials/quote',
    oncallApiPath: '/api/oncall/industrials/quote',
    owner: 'Alex Romero (manufacturing-platform-oncall)',
    brand: 'Titan Mfg (Instant Quote)',
    service: 'quote-api',
    endpoint: 'POST /api/oncall/industrials/quote',
    monitor: 'p95 latency — POST /api/oncall/industrials/quote',
    metricQuery: 'p95:trace.express.request.duration{service:checkout-api,resource:POST /api/oncall/industrials/quote}',
    metricValue: '14.2s',
    threshold: '> 2s',
    baseline: '~310ms (7-day p95)',
    release: 'titan-mfg@1.0.1',
    symptom: 'Requests routed through the F3 edge site hang ~14s before completing. F2/F4 are normal and error rate is normal.',
    impact: 'Factory teams wait through a long instant-quote spinner for F3 work while other sites return normally.',
  },
  vaccines: {
    vertical: 'vaccines',
    page: 'fe4f39ba.html',
    apiPath: '/api/vaccines/order',
    oncallApiPath: '/api/oncall/vaccines/order',
    owner: 'Jordan Patel (hcp-ordering-oncall)',
    brand: 'Vaccine Ordering (HCP Portal)',
    service: 'vaccine-ordering-api',
    endpoint: 'POST /api/oncall/vaccines/order',
    monitor: '5xx rate — POST /api/oncall/vaccines/order',
    metricQuery: 'sum:trace.express.request.errors{service:checkout-api,resource:POST /api/oncall/vaccines/order,http.status_code:504}',
    metricValue: '504 on ~100% of order submissions',
    threshold: '> 5% error rate',
    baseline: '<0.3% (7-day)',
    release: 'hcp-ordering-web@1.0.4',
    symptom: 'Vaccine order submissions hang ~8s and then fail with 504 Gateway Timeout. Allocation-hold latency against the cold-chain distribution partner is elevated.',
    impact: 'Practices cannot place vaccine orders; every submission sits on a spinner and then errors. The Vaccine Service Center is reporting rising call volume.',
    unlisted: true,
  },
  f8555891: {
    vertical: 'f8555891',
    page: 'f8555891.html',
    apiPath: '/api/f8555891/release-batch',
    oncallApiPath: '/api/f8555891/release-batch',
    owner: 'Priya Natarajan (payroll-platform-oncall)',
    brand: 'Gusto (Payroll Operations)',
    service: 'customer-f8555891-payroll',
    endpoint: 'POST /api/f8555891/release-batch',
    monitor: 'Error rate — payroll batch ACH release',
    metricQuery: 'sum:gusto_payroll.batch_release_failure{service:customer-f8555891-payroll} by {state}.as_count()',
    metricValue: '100% of release attempts failing (HTTP 500 BATCH_RELEASE_FAILED)',
    threshold: '> 0 failures / 5m',
    baseline: '0 failures (30-day)',
    release: 'gusto-payroll-platform@2026.09.15',
    symptom: 'Releasing ACH debits for batch PB-2026-09-15-A fails on every attempt. Failures carry state:MN; the same batch releases cleanly when the one MN company (CO-51177) is excluded.',
    impact: 'Sep 17 pay date for 5 companies / 133 employees is blocked ahead of the 17:30 PT ACH cutoff. MN is a newly onboarded work state.',
    // Gusto-branded console at /gusto, not the generic on-call hub.
    demoPage: '/gusto',
    unlisted: true,
  },
};

function resolveOncallEnv() {
  return {
    token: process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN,
    alertsChannel: process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
    bugsChannel: process.env.SLACK_ONCALL_BUGS_CHANNEL_ID,
    teamsWebhookUrl: process.env.ONCALL_TEAMS_WEBHOOK_URL,
    teamsAllAlerts: process.env.ONCALL_TEAMS_ALL_ALERTS === 'true',
  };
}

/**
 * Generate a short unique run reference so each demo run produces a
 * distinguishable alert (and can dodge duplicate-grouping when desired).
 */
function makeRunRef() {
  return `run-${crypto.randomBytes(6).toString('hex')}`;
}

const DD_URL = () => process.env.DD_DASHBOARD_URL || 'https://app.datadoghq.com';

/**
 * Resolve the demo user's hub identity email to a Slack @mention so cards
 * show who launched the trigger (same attribution as the legacy alerts).
 */
const EMAIL_RE = /^[^\s@<>|]{1,64}@[^\s@<>|]{1,255}$/;

async function resolveTriggeredBy(token, devinEmail) {
  // Validate shape so a client-supplied value can't inject Slack mrkdwn
  // (e.g. <!channel>) into the cards.
  if (!devinEmail || !EMAIL_RE.test(devinEmail)) return null;
  try {
    const memberId = await lookupSlackUserByEmail(token, devinEmail);
    return memberId ? `<@${memberId}>` : devinEmail;
  } catch (error) {
    logger.warn('Triggered-by Slack lookup failed', { error: error.message });
    return devinEmail;
  }
}

/**
 * Shared Block Kit helpers so On-Call cards match the polish of the legacy
 * Automated Alerts cards (header, field grid, action buttons, context row).
 */
function fieldPairs(pairs) {
  const fields = pairs
    .filter((p) => p && p[1])
    .map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}:*\n${value}` }));
  const blocks = [];
  for (let i = 0; i < fields.length; i += 2) {
    blocks.push({ type: 'section', fields: fields.slice(i, i + 2) });
  }
  return blocks;
}

function headerBlock(text) {
  return { type: 'header', text: { type: 'plain_text', text, emoji: true } };
}

function mrkdwnSection(text) {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function datadogActions() {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: ':bar_chart: View in Datadog', emoji: true },
        url: DD_URL(),
      },
    ],
  };
}

function contextBlock(service, triggeredBy, submittedFrom) {
  const parts = [`Service: \`${service || 'checkout-api'}\``];
  if (submittedFrom) parts.push(`Submitted from: <${submittedFrom}|${submittedFrom.replace(/^https?:\/\//, '')}>`);
  parts.push(new Date().toISOString());
  if (triggeredBy) parts.push(`Triggered by ${triggeredBy}`);
  return {
    type: 'context',
    elements: [{ type: 'mrkdwn', text: parts.join(' | ') }],
  };
}

/**
 * Build the plain-text alert card for a scenario.
 * When `unique` is true, a per-run reference is woven into the alert so the
 * responder treats it as a fresh occurrence; when false, the message matches
 * the canonical signature to demonstrate duplicate grouping.
 */
function demoPagePath(scenario, skin) {
  if (skin) return `/oncall/c/${skin.slug}`;
  return scenario.demoPage || null;
}

function demoPageLine(scenario, skin) {
  const path = demoPagePath(scenario, skin);
  return path ? `*Affected page:* ${DEMO_BASE_URL()}${path}` : null;
}

/**
 * Alert card copy for a scenario with a skin's optional alertCard overrides
 * applied. Without overrides the scenario itself is returned, so the card is
 * unchanged.
 */
function resolveAlertCard(scenario, skin) {
  const card = skin && isPlainObject(skin.alertCard) ? skin.alertCard : null;
  if (!card) return scenario;
  const pick = (key, fallback) => (typeof card[key] === 'string' && card[key].trim() ? card[key] : fallback);
  const team = pick('team', null);
  return {
    ...scenario,
    monitor: pick('title', scenario.monitor),
    service: pick('service', scenario.service),
    endpoint: pick('endpointLabel', scenario.endpoint),
    release: pick('release', scenario.release),
    owner: team ? `${scenario.owner.replace(/\s*\([^)]*\)$/, '')} (${team})` : scenario.owner,
    metricQuery: pick('metricQuery', scenario.metricQuery),
    metricValue: pick('metricValue', scenario.metricValue),
    threshold: pick('threshold', scenario.threshold),
    baseline: pick('baseline', scenario.baseline),
    symptom: pick('symptom', scenario.symptom),
    impact: pick('impact', scenario.impact),
  };
}

function buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy, skin }) {

  const card = resolveAlertCard(scenario, skin);
  const brand = skin ? skin.company : scenario.brand;
  const lines = [
    `:rotating_light: *[Triggered] ${card.monitor}*`,
    '',
    `*Service:* ${card.service} (${brand})`,
    demoPageLine(scenario, skin),
    `*Endpoint:* ${card.endpoint}`,
    `*Metric value:* ${card.metricValue} | *Threshold:* ${card.threshold} | *Baseline:* ${card.baseline}`,
    `*Monitor query:* \`${card.metricQuery}\``,
    `*Owner:* ${ownerRotation(card.owner)}`,
    runRef ? `*Incident Ref:* ${runRef}` : null,
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
    '',
    `Env: production | Release: ${card.release}`,
    `Events: ${events} | First: ${firstSeen.toISOString()} | Last: ${now.toISOString()}`,
    '',
    `Repo: ${REPO_URL}`,
  ];

  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Investigation prompt for a skin's auto-triage session. Built only from the
 * scenario's monitor-shaped facts — the same signal a human responder gets —
 * so no code locations, and no request-derived text, reach the session.
 */
const SLACK_MEMBER_ID_RE = /^[A-Z0-9]{1,32}$/i;
const SLACK_CHANNEL_ID_RE = /^[A-Z0-9]{1,32}$/i;
const SLACK_TS_RE = /^\d{1,16}\.\d{1,9}$/;

function notifySlackMemberParagraph(memberId, channel, threadTs) {
  const mention = `<@${memberId}>`;
  return [
    'Progress updates for the on-call engineer: reply in the Slack alert thread above twice — '
      + `(1) as soon as the root cause is confirmed, post ${mention} + the root cause in ≤3 lines; `
      + `(2) as soon as the fix PR is open, post ${mention} + the PR link + one line on how you verified. `
      + 'Post with `curl -s -X POST https://slack.com/api/chat.postMessage -H "Authorization: Bearer $SLACK_ONCALL_BOT_TOKEN" '
      + `-H 'Content-Type: application/json' -d '{"channel":"${channel}","thread_ts":"${threadTs}","text":"..."}'\` `
      + '(fall back to `$COG_GTM_DEMO_SLACK_BOT_TOKEN`; both are org secrets available as env vars in the triage session — never print them). '
      + 'If neither token is set, use the Devin `slack` tool with `thread_ts`.',
  ].join('');
}

function buildOncallSessionPrompt(scenario, skin, runRef, { channel, threadTs } = {}) {
  const lines = [
    `A Datadog monitor is firing on ${scenario.service}. Investigate it and open a PR with the fix.`,
    '',
    `*Monitor:* ${scenario.monitor} — Triggered`,
    `*Query:* \`${scenario.metricQuery}\``,
    `*Endpoint:* ${scenario.endpoint}`,
    `*Metric value:* ${scenario.metricValue} (threshold ${scenario.threshold}, baseline ${scenario.baseline})`,
    `*Release:* ${scenario.release}`,
    `*Symptom:* ${scenario.symptom}`,
    `*Impact:* ${scenario.impact}`,
    runRef ? `*Incident Ref:* ${runRef}` : null,
    '',
    `Reproduce the symptom at ${DEMO_BASE_URL()}/oncall/c/${skin.slug} and diagnose it from the repository and its telemetry: ${REPO_URL}`,
  ].filter((l) => l !== null);

  if (
    skin.devinSession
    && typeof skin.devinSession.promptAppendix === 'string'
    && skin.devinSession.promptAppendix.trim()
  ) {
    lines.push('');
    lines.push(skin.devinSession.promptAppendix);
  }

  const hasThread = SLACK_CHANNEL_ID_RE.test(channel || '') && SLACK_TS_RE.test(threadTs || '');
  if (hasThread) {
    lines.push('');
    lines.push(`*Slack Thread:* channel=${channel} thread_ts=${threadTs}`);
  }

  const notifyId = skin.devinSession && skin.devinSession.notifySlackMemberId;
  if (hasThread && typeof notifyId === 'string' && SLACK_MEMBER_ID_RE.test(notifyId)) {
    lines.push('');
    lines.push(notifySlackMemberParagraph(notifyId, channel, threadTs));
  }

  return lines.join('\n');
}

/**
 * Identity of the person who triggered the run, as the demo header resolved it
 * (org name + email → Devin ids) and the page forwarded it. Sessions are then
 * created under that account instead of the service user's. Ids are shape-
 * checked because they arrive from the browser, and org and user are taken as
 * one identity: a user id only belongs to the org it was resolved against, so
 * a requester org with no user runs as that org's service user rather than
 * borrowing a user id from the skin or the environment.
 */
const DEVIN_ORG_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// User ids carry their identity provider as a prefix, e.g. `email|<hex>`.
const DEVIN_USER_ID_RE = /^[A-Za-z0-9_|.@+-]{1,128}$/;

function resolveRequesterIdentity({ devinOrgId, devinUserId } = {}) {
  const orgId = DEVIN_ORG_ID_RE.test(devinOrgId || '') ? devinOrgId : null;
  if (!orgId) return { orgId: null, userId: null, complete: false };
  return {
    orgId,
    userId: DEVIN_USER_ID_RE.test(devinUserId || '') ? devinUserId : null,
    complete: true,
  };
}

/**
 * Pick the account the session is created under. A Devin user id only exists
 * inside one org, so each source is taken whole: mixing a skin's org with the
 * environment's user yields a pair the API rejects. A source that names an org
 * but no user runs as that org's service user.
 */
function resolveSessionIdentity(requester, config) {
  if (requester.complete) return { orgId: requester.orgId, userId: requester.userId };
  if (config.orgId) return { orgId: config.orgId, userId: config.userId || null };
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
  };
}

/**
 * Create the auto-triage Devin session for a skin that opted in, and reply
 * with its link in the Slack alert thread. Never throws: a failed session must
 * not fail the alert that triggered it.
 */
async function triggerSkinDevinSession(
  scenario,
  skin,
  { token, channel, threadTs, runRef, requester },
) {
  const config = skin.devinSession;
  if (!config || !config.auto) return null;

  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('On-Call skin session creation throttled', { skin: skin.slug, ...cap });
    return null;
  }

  // Reserve before the async call so concurrent alerts cannot all pass the cap check.
  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildOncallSessionPrompt(scenario, skin, runRef, { channel, threadTs }), {
      ...resolveSessionIdentity(requester, config),
      apiKey: config.apiKey || process.env.DEVIN_ONCALL_SERVICE_KEY,
      title: `[On-Call] ${scenario.monitor}`,
    });
  } catch (error) {
    logger.error('On-Call skin Devin session failed', { skin: skin.slug, error: error.message });
  }

  if (!session) {
    release();
    return null;
  }

  logger.info('On-Call skin Devin session created', {
    skin: skin.slug,
    scenario: scenario.vertical,
    sessionId: session.sessionId,
  });

  try {
    await postThreadReply(token, channel, threadTs, `Devin is investigating: ${session.url}`, [
      mrkdwnSection(`:mag: *Devin is investigating this alert* — <${session.url}|View session>`),
    ]);
  } catch (error) {
    logger.error('On-Call skin session link reply failed', { skin: skin.slug, error: error.message });
  }

  return session;
}

/**
 * Queue the SonarCloud remediation demo PR for a skin that opted in with
 * sonarPR: { auto: true }. Fire-and-forget like the legacy alert flow; the
 * trigger itself logs and skips when no GitHub token is configured.
 */
function triggerSkinSonarPR(skin, requester) {
  const config = skin && skin.sonarPR;
  if (!config || !config.auto) return false;
  scheduleVulnerablePR(0, config.customer || 'default', requester.userId || undefined, requester.orgId || undefined);
  return true;
}

/**
 * Post an alert card for the given scenario to the On-Call alerts channel.
 */
function validEmail(email) {
  return email && EMAIL_RE.test(email) ? email : null;
}

/**
 * Mirror of the Slack alert card for Teams. Delivery is best-effort: a failed
 * Teams post is logged and never blocks the Slack card.
 */
async function postTeamsAlert(webhookUrl, scenario, skin, { card, brand, runRef, events, firstSeen, triggeredByEmail }) {
  const demoPath = demoPagePath(scenario, skin);
  const teamsCard = buildTeamsAlertCard({
    title: `\u{1F6A8} [Triggered] ${card.monitor}`,
    facts: [
      ['Service', `${card.service} (${brand})`],
      ['Endpoint', card.endpoint],
      ['Metric value', card.metricValue],
      ['Threshold', card.threshold],
      ['Baseline', card.baseline],
      ['Release', card.release],
      ['Events', `${events} | First: ${firstSeen.toISOString()}`],
      ['Triggered by', triggeredByEmail],
    ],
    monitorQuery: card.metricQuery,
    // Top-level TextBlocks: the Teams responder drops FactSet rows.
    body: [
      `**Owner:** ${ownerRotation(card.owner)}`,
      demoPath ? `**Affected page:** ${DEMO_BASE_URL()}${demoPath}` : null,
      `Repo: ${REPO_URL}`,
    ],
    actions: [
      { title: 'View in Datadog', url: DD_URL() },
      demoPath ? { title: 'Open affected page', url: `${DEMO_BASE_URL()}${demoPath}` } : null,
    ],
    footer: [
      runRef ? `Incident Ref: ${runRef}` : null,
      `Service: ${card.service}`,
      `Endpoint: ${card.endpoint}`,
    ].filter(Boolean).join(' | '),
  });
  try {
    await postTeamsCard(webhookUrl, teamsCard);
    logger.info('On-Call alert posted to Teams', { scenario: scenario.vertical || scenario.service });
    return true;
  } catch (error) {
    logger.warn('On-Call Teams alert post failed', { error: error.message, status: error.response && error.response.status });
    return false;
  }
}

async function postOncallAlert(scenarioId, options = {}) {
  const scenario = ALERT_SCENARIOS[scenarioId];
  if (!scenario) {
    return { ok: false, error: `Unknown scenario: ${scenarioId}` };
  }

  const skin = options.skin || null;
  const env = resolveOncallEnv();
  const { token, alertsChannel } = env;
  // destination: 'slack' | 'teams' from the presenter's hub choice. Teams skips
  // Slack so one demo is never investigated by both the Slack and the Teams
  // responder; with no Teams webhook configured it falls back to Slack.
  const destination = options.destination === 'slack' || options.destination === 'teams' ? options.destination : null;
  const teamsWanted = destination === 'teams';
  const teamsOnly = teamsWanted && Boolean(env.teamsWebhookUrl);
  if (teamsWanted && !teamsOnly) {
    logger.warn('Teams On-Call alert requested but ONCALL_TEAMS_WEBHOOK_URL is not set — posting to Slack');
  }
  // Server-managed Teams routing only applies to callers that made no choice.
  const serverTeamsRouting = !destination && (env.teamsAllAlerts || Boolean(skin && skin.teamsAlerts));
  const teamsWebhookUrl = teamsOnly || serverTeamsRouting ? env.teamsWebhookUrl : null;
  const slackReady = Boolean(token && alertsChannel) && !teamsOnly;
  if (!slackReady && !teamsWebhookUrl) {
    logger.warn('On-Call alerts channel not configured — skipping alert post');
    return { ok: false, skipped: true, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  const runRef = options.runRef || (options.unique !== false ? makeRunRef() : null);
  const triggeredBy = slackReady ? await resolveTriggeredBy(token, options.devinEmail) : null;
  const now = new Date();
  const firstSeen = new Date(now.getTime() - (5 + Math.floor(Math.random() * 20)) * 60000);
  const events = 3 + Math.floor(Math.random() * 12);
  const text = buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy, skin });
  const card = resolveAlertCard(scenario, skin);
  const brand = skin ? skin.company : scenario.brand;
  const blocks = [
    headerBlock(`:rotating_light: [Triggered] ${card.monitor}`),
    ...fieldPairs([
      ['Service', `${card.service} (${brand})`],
      ['Endpoint', card.endpoint],
      ['Metric value', card.metricValue],
      ['Threshold', card.threshold],
      ['Baseline', card.baseline],
      ['Release', card.release],
      ['Events', `${events} | First: ${firstSeen.toISOString()}`],
      ['Owner', ownerRotation(card.owner)],
      runRef ? ['Incident Ref', runRef] : null,
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    mrkdwnSection(`*Monitor query:*\n\`\`\`${card.metricQuery}\`\`\``),
    mrkdwnSection(
      (demoPageLine(scenario, skin) ? `${demoPageLine(scenario, skin)}\n` : '') +
      `Repo: ${REPO_URL}`
    ),
    datadogActions(),
    contextBlock(card.service, triggeredBy),
  ];
  const teamsDelivery = teamsWebhookUrl
    ? postTeamsAlert(teamsWebhookUrl, scenario, skin, {
      card, brand, runRef, events, firstSeen, triggeredByEmail: validEmail(options.devinEmail),
    })
    : Promise.resolve(null);
  let ts = null;
  if (slackReady) {
    try {
      ts = await postMessage(token, alertsChannel, text, blocks);
      logger.info('On-Call alert posted', { scenario: scenarioId, channel: alertsChannel, ts });
    } catch (error) {
      if (!(await teamsDelivery)) throw error;
      logger.warn('On-Call Slack alert post failed; alert delivered to Teams', { error: error.message });
    }
  }
  const teams = await teamsDelivery;
  if (!ts && !teams) {
    return { ok: false, error: 'Teams alert post failed' };
  }
  const requester = resolveRequesterIdentity(options);
  // Teams-only alerts skip the skin's session: the Teams channel responder
  // already investigates the alert, and a second session would duplicate it.
  const session = skin && ts
    ? await triggerSkinDevinSession(scenario, skin, {
      token, channel: alertsChannel, threadTs: ts, runRef, requester,
    })
    : null;
  const sonarPR = triggerSkinSonarPR(skin, requester);
  return {
    ok: true,
    ...(ts ? { ts, channel: alertsChannel } : {}),
    ...(teams ? { teams: true } : {}),
    ...(teamsWanted && !teamsOnly ? { teamsFailed: true } : {}),
    ...(session ? { sessionUrl: session.url } : {}),
    ...(sonarPR ? { sonarPR: true } : {}),
  };
}

/**
 * Post a human-style bug report to the On-Call bugs channel.
 * Accepts either a canned scenario id or free-form text. With `threadTs` the
 * ticket is filed as a sub-ticket in that parent ticket's thread; `ticketId`
 * is shown in the header the way a support tool labels a case.
 */
async function postOncallBugReport({ text, reporter, severity, productArea, devinEmail, supportCenter, submittedFrom, threadTs, ticketId, parentTicketId }) {
  const { token, bugsChannel } = resolveOncallEnv();

  const body = text;
  if (!body) {
    return { ok: false, error: 'No bug report text' };
  }

  if (!token || !bugsChannel) {
    logger.warn('On-Call bugs channel not configured — skipping bug report post');
    return {
      ok: false,
      skipped: true,
      error: 'SLACK_ONCALL_BUGS_CHANNEL_ID or bot token not configured',
    };
  }

  const triggeredBy = await resolveTriggeredBy(token, devinEmail);
  let message = [
    body,
    triggeredBy ? `Triggered by: ${triggeredBy}` : null,
    submittedFrom ? `Submitted from: ${submittedFrom}` : null,
  ].filter((l) => l !== null).join('\n');
  let blocks = null;
  if (reporter || severity || productArea) {
    const reportedBy = reporter && (reporter.name || reporter.email)
      ? [reporter.name, reporter.email && `<${reporter.email}>`].filter(Boolean).join(' ')
      : null;
    const centerName = supportCenter || 'Acme Support Center';
    const centerSlug = centerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const label = ticketId ? ` ${ticketId}` : '';
    const heading = threadTs
      ? `:page_facing_up: Sub-ticket${label} — ${centerName}`
      : `:inbox_tray: New support ticket${label} — ${centerName}`;
    message = [
      heading,
      parentTicketId ? `Parent ticket: ${parentTicketId}` : null,
      reportedBy ? `Reported by: ${reportedBy}` : null,
      productArea ? `Product area: ${productArea}` : null,
      severity ? `Severity: ${severity}` : null,
      triggeredBy ? `Triggered by: ${triggeredBy}` : null,
      '',
      body,
      submittedFrom ? `Submitted from: ${submittedFrom}` : null,
    ].filter((l) => l !== null).join('\n');
    blocks = [
      headerBlock(heading),
      ...fieldPairs([
        parentTicketId ? ['Parent ticket', parentTicketId] : null,
        reportedBy ? ['Reported by', reportedBy] : null,
        productArea ? ['Product area', productArea] : null,
        severity ? ['Severity', severity] : null,
      ]),
      mrkdwnSection(body),
      contextBlock(centerSlug, triggeredBy, submittedFrom),
    ];
  }

  const ts = threadTs
    ? await postThreadReply(token, bugsChannel, threadTs, message, blocks)
    : await postMessage(token, bugsChannel, message, blocks);
  logger.info('On-Call bug report posted', {
    channel: bugsChannel,
    ts,
    threadTs: threadTs || null,
    ticketId: ticketId || null,
  });
  return {
    ok: true,
    ts,
    channel: bugsChannel,
  };
}

/**
 * Infra-style (SRE) incidents: each activates one of the app's built-in
 * incident scenarios (so the degradation is genuinely observable in latency,
 * logs, and error rates), posts a Datadog-monitor-style alert card to the
 * alerts channel, and auto-reverts to healthy after a window so the regular
 * demos are unaffected.
 */
function envNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const INFRA_WINDOW_MS = envNumber(
  process.env.ONCALL_INFRA_WINDOW_MS || process.env.ONCALL_LATENCY_WINDOW_MS,
  10 * 60 * 1000,
);

/**
 * Per-run degradation registry: each activation is scoped to its run ref, so
 * only requests carrying that run's oncall_run cookie see the symptoms.
 * Concurrent runs are fully independent — nothing here touches the global
 * scenario slot used by the admin endpoint.
 */
const scopedInfra = new Map();

/**
 * Bounded, reversible memory-growth mode for the memory-leak incident.
 * Holds real allocated buffers so the process RSS genuinely climbs in
 * Datadog, but is strictly capped (ONCALL_MEMLEAK_CAP_MB, default 150MB)
 * well below the container limit and freed when the window ends.
 */
const MEMLEAK_CAP_MB = Math.min(envNumber(process.env.ONCALL_MEMLEAK_CAP_MB, 150), 300);
const MEMLEAK_CHUNK_MB = 8;
let memLeakChunks = [];
let memLeakInterval = null;

function startMemoryGrowth(windowMs) {
  stopMemoryGrowth();
  const steps = Math.max(1, Math.floor(MEMLEAK_CAP_MB / MEMLEAK_CHUNK_MB));
  const intervalMs = Math.max(2000, Math.floor(windowMs / (steps + 1)));
  memLeakInterval = setInterval(() => {
    if (memLeakChunks.length >= steps) {
      clearInterval(memLeakInterval);
      memLeakInterval = null;
      return;
    }
    // fill(1) forces the OS to actually commit the pages so RSS rises
    memLeakChunks.push(Buffer.alloc(MEMLEAK_CHUNK_MB * 1024 * 1024, 1));
    logger.warn('Simulated memory growth', {
      heldMB: memLeakChunks.length * MEMLEAK_CHUNK_MB,
      capMB: MEMLEAK_CAP_MB,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  }, intervalMs);
  if (memLeakInterval.unref) memLeakInterval.unref();
}

/**
 * A browser carries a single oncall_run cookie, so a new trigger replaces
 * the caller's previous run. Revert the old run's degradation so nothing is
 * left silently active with no cookie pointing at it. A prior SEV-1's
 * Datadog incident keeps its own auto-resolve timer.
 */
function supersedePriorRun(newRunRef) {
  const prior = getOncallRunRef();
  if (prior && prior !== newRunRef) {
    revertScopedInfra(prior, 'superseded by a new run from the same browser');
    clearOncallConfigOverride(prior, 'superseded by a new run from the same browser');
  }
}

function revertScopedInfra(runRef, reason) {
  const entry = scopedInfra.get(runRef);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.scenario) clearScopedScenario(runRef);
  scopedInfra.delete(runRef);
  clearOncallConfigOverride(runRef, reason);
  // Memory growth is inherently process-wide (RSS); release it only once no
  // other live run still needs it.
  if (entry.memoryGrowth && !Array.from(scopedInfra.values()).some((e) => e.memoryGrowth)) {
    stopMemoryGrowth();
  }
  logger.info('On-Call infra incident state reverted to healthy', { runRef, reason });
}

function stopMemoryGrowth() {
  if (memLeakInterval) clearInterval(memLeakInterval);
  memLeakInterval = null;
  if (memLeakChunks.length > 0) {
    memLeakChunks = [];
    if (global.gc) global.gc();
    logger.info('Simulated memory growth released', {
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    });
  }
}

const INFRA_INCIDENTS = {
  latency: {
    scenario: 'slow-db',
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const p95 = (2.1 + Math.random() * 1.2).toFixed(2);
      const baseline = (0.18 + Math.random() * 0.08).toFixed(2);
      return {
        title: ':warning: [Triggered] p95 latency spike — checkout-api endpoints',
        monitor: '`avg(last_5m):p95:trace.express.request{service:checkout-api} > 2` — *Triggered*',
        fields: [
          ['Current p95', `${p95}s (baseline ${baseline}s)`],
          ['Affected endpoints', 'GET /search, POST /checkout'],
        ],
        symptoms: `GET /search and POST /checkout requests are slow; app logs show "Slow search query" and "Slow database query detected" warnings with 1500–3000ms query times. Error rate is normal — this is a latency degradation, not an outage. First: ${new Date(now.getTime() - 6 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the slow query paths in app/routes/search.js, app/services/search.js, app/routes/checkout.js, and app/services/checkout.js. Repo: ${REPO_URL}`,
      };
    },
  },
  'dependency-timeout': {
    scenario: 'dependency-timeout',
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const timeoutPct = (26 + Math.random() * 10).toFixed(1);
      const p99 = (5.0 + Math.random() * 0.4).toFixed(2);
      return {
        title: ':hourglass_flowing_sand: [Triggered] payments-gateway timeouts — POST /checkout degraded',
        monitor: '`sum(last_10m):checkout.dependency_timeout{upstream:payments-gateway}.as_rate() > 0.2` — *Triggered*',
        fields: [
          ['Timeout rate', `${timeoutPct}% of checkout calls timing out against payments-gateway (5s deadline)`],
          ['Current p99 on POST /checkout', `${p99}s`],
          ['Blast radius', 'intermittent — most checkouts succeed, affected users see a spinner then a 504'],
        ],
        symptoms: `App logs show "PaymentGatewayTimeoutError" bursts; upstream payments-gateway p50 looks normal, suggesting a connection-handling or timeout-budget issue on our side rather than a provider outage. First: ${new Date(now.getTime() - 9 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the timeout handling in app/routes/checkout.js and app/services/checkout.js. Repo: ${REPO_URL}`,
      };
    },
  },
  'memory-leak': {
    scenario: 'healthy',
    memoryGrowth: true,
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const baselineRss = Math.round(process.memoryUsage().rss / 1024 / 1024);
      return {
        title: ':chart_with_upwards_trend: [Triggered] memory growth — checkout-api',
        monitor: `\`avg(last_30m):system.mem.rss{service:checkout-api} > ${baselineRss + 50}MB\` — *Triggered*`,
        fields: [
          ['Current RSS', `${baselineRss}MB and climbing steadily (holding pattern expected ~flat)`],
          ['Projected', `+${MEMLEAK_CAP_MB}MB within the hour at current growth rate`],
          ['User impact', 'none yet — latency will creep up as heap pressure grows; OOM restart projected if unaddressed'],
        ],
        symptoms: `RSS climbs monotonically and never plateaus — consistent with an unbounded in-process cache or listener accumulation rather than load. First: ${new Date(now.getTime() - 20 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate in-process caches and per-request allocations that survive the request lifecycle. Repo: ${REPO_URL}`,
      };
    },
  },
  'slo-burn': {
    scenario: 'checkout-regression',
    owner: 'Riley Chen (platform-oncall)',
    build(now) {
      const burn = (12 + Math.random() * 5).toFixed(1);
      const errPct = (46 + Math.random() * 6).toFixed(1);
      return {
        title: ':rotating_light: [SLO] Fast burn — checkout availability error budget',
        monitor: `\`burn_rate(slo:checkout-availability-99.9, window:1h) > 14.4\` — *Fast burn: ${burn}x*`,
        fields: [
          ['SLO', 'checkout availability 99.9% (30d) — monthly error budget exhausted in < 2 days at this rate'],
          ['Error rate', `${errPct}% of POST /checkout requests failing (InventoryReservationError, TypeError)`],
        ],
        symptoms: `Intermittent checkout failures — a mix of inventory reservation conflicts and tax-calculation errors on roughly half of orders; retries succeed sometimes. Budget burn is what tripped this. First: ${new Date(now.getTime() - 32 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the inventory reservation and tax calculation paths in app/services/checkout.js. Repo: ${REPO_URL}`,
      };
    },
  },
};

/**
 * Activate an infra incident's real degradation (scenario mode and/or memory
 * growth) with the standard auto-revert window. Returns true if any state
 * was activated.
 */
function activateInfraIncident(kind, windowMs = INFRA_WINDOW_MS, runRef) {
  const incident = INFRA_INCIDENTS[kind];
  if (!incident || !runRef) return false;
  if (incident.scenario === 'healthy' && !incident.memoryGrowth) return false;
  revertScopedInfra(runRef, 'superseded by new incident');
  const entry = {
    kind,
    scenario: null,
    memoryGrowth: Boolean(incident.memoryGrowth),
    revertAt: Date.now() + windowMs,
    timer: null,
  };
  if (incident.scenario !== 'healthy') {
    setScopedScenario(runRef, incident.scenario);
    entry.scenario = incident.scenario;
  }
  // Memory growth is process-wide RSS: keep it monotonic across concurrent
  // runs by only starting the allocator when no other live run holds it.
  if (incident.memoryGrowth && !Array.from(scopedInfra.values()).some((e) => e.memoryGrowth)) {
    startMemoryGrowth(windowMs);
  }
  entry.timer = setTimeout(() => {
    revertScopedInfra(runRef, `window elapsed for ${kind}`);
  }, windowMs);
  if (entry.timer.unref) entry.timer.unref();
  scopedInfra.set(runRef, entry);
  return true;
}

async function postOncallInfraIncident(kind = 'latency', options = {}) {
  const incident = INFRA_INCIDENTS[kind];
  if (!incident) {
    return { ok: false, error: `Unknown infra incident: ${kind}` };
  }

  const runRef = makeRunRef();
  const { token, alertsChannel } = resolveOncallEnv();
  if (!token || !alertsChannel) {
    logger.warn('On-Call alerts channel not configured — skipping infra alert');
    return { ok: false, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  supersedePriorRun(runRef);
  activateInfraIncident(kind, INFRA_WINDOW_MS, runRef);

  const triggeredBy = await resolveTriggeredBy(token, options.devinEmail);
  const now = new Date();
  const card = incident.build(now);
  const ownerLine = ownerRotation(incident.owner);
  const text = [
    `${card.title}`,
    `Monitor: ${card.monitor}`,
    ...card.fields.map(([label, value]) => `${label}: ${value}`),
    `Symptoms: ${card.symptoms}`,
    'Service: checkout-api | Env: production',
    `Owner: ${ownerLine}`,
    `Incident Ref: ${runRef}`,
    triggeredBy ? `Triggered by: ${triggeredBy}` : null,
    card.instruction,
  ].filter((l) => l !== null).join('\n');
  const blocks = [
    headerBlock(card.title),
    mrkdwnSection(`*Monitor:* ${card.monitor}`),
    ...fieldPairs([
      ...card.fields,
      ['Env', 'production'],
      ['Service', '`checkout-api`'],
      ['Owner', ownerLine],
      ['Incident Ref', runRef],
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    mrkdwnSection(`*Symptoms:* ${card.symptoms}`),
    mrkdwnSection(card.instruction),
    datadogActions(),
    contextBlock('checkout-api', triggeredBy),
  ];

  let ts;
  try {
    ts = await postMessage(token, alertsChannel, text, blocks);
  } catch (error) {
    // Keep observable state consistent with what was announced: if the alert
    // never posted, don't leave the app silently degraded for the full window.
    revertScopedInfra(runRef, 'infra alert post failed');
    throw error;
  }
  logger.info('On-Call infra incident posted', { kind, channel: alertsChannel, ts, runRef, windowMs: INFRA_WINDOW_MS });
  return {
    ok: true,
    ts,
    channel: alertsChannel,
    runRef,
    kind,
    scenario: incident.scenario,
    active: incident.scenario !== 'healthy' || Boolean(incident.memoryGrowth),
    windowMinutes: Math.round(INFRA_WINDOW_MS / 60000),
  };
}

/**
 * Live state for the /oncall page's health strip: current scenario, active
 * infra incident (and time remaining), and process memory.
 */
function getInfraState() {
  // Scoped to the caller: reports the degradation belonging to the run ref
  // on the request's oncall_run cookie (if any), never someone else's run.
  const runRef = getOncallRunRef();
  const entry = runRef ? scopedInfra.get(runRef) : null;
  return {
    scenario: getScenario(),
    runRef: entry ? runRef : null,
    activeKind: entry ? entry.kind : null,
    memoryGrowth: Boolean(entry && entry.memoryGrowth),
    heldMB: memLeakChunks.length * MEMLEAK_CHUNK_MB,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    msRemaining: entry ? Math.max(0, entry.revertAt - Date.now()) : null,
  };
}

/**
 * Per-run runtime config overrides — the mitigation surface for the on-call
 * demos. A responder registers an override for their run ref (e.g. reverting
 * the compliance screening parameters); only requests scoped to that run see
 * it, and it auto-expires so the app returns to its shipped (degraded)
 * configuration for the next demo. The shipped config itself never changes.
 */
const CONFIG_OVERRIDE_FIELDS = {
  screeningWindowDays: { min: 1, max: 365 },
  // The concurrency ceiling keeps a brute-force parallelism bump from clearing
  // the recovery threshold on its own: at 5, the full 90-day window still
  // screens well above threshold (~2s), so the lookback regression must also
  // be fixed before the incident can confirm recovery.
  screeningConcurrency: { min: 1, max: 5 },
};
const CONFIG_OVERRIDE_TTL_MS = envNumber(process.env.ONCALL_CONFIG_OVERRIDE_TTL_MS, 45 * 60 * 1000);
// Overrides are keyed by caller-supplied run refs, so the registry is capped
// like the other per-run registries; the oldest override is evicted first.
const CONFIG_OVERRIDE_MAX = envNumber(process.env.ONCALL_CONFIG_OVERRIDE_MAX, 50);
const configOverrides = new Map();

function clearOncallConfigOverride(runRef, reason) {
  const entry = configOverrides.get(runRef);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  configOverrides.delete(runRef);
  clearScopedConfig(runRef);
  logger.info('On-Call config override cleared', { runRef, reason });
}

function setOncallConfigOverride(runRef, patch) {
  if (!runRef || !/^[A-Za-z0-9-]+$/.test(runRef)) {
    return { ok: false, error: 'A valid runRef is required' };
  }
  const applied = {};
  for (const [field, value] of Object.entries(patch || {})) {
    if (!Object.prototype.hasOwnProperty.call(CONFIG_OVERRIDE_FIELDS, field)) continue;
    const spec = CONFIG_OVERRIDE_FIELDS[field];
    const n = Number(value);
    if (!Number.isInteger(n) || n < spec.min || n > spec.max) {
      return { ok: false, error: `${field} must be an integer between ${spec.min} and ${spec.max}` };
    }
    applied[field] = n;
  }
  if (Object.keys(applied).length === 0) {
    return { ok: false, error: `No recognized config fields. Supported: ${Object.keys(CONFIG_OVERRIDE_FIELDS).join(', ')}` };
  }

  // The override lives as long as the run it belongs to: an active infra
  // incident's remaining window, or the standard TTL otherwise.
  const infra = scopedInfra.get(runRef);
  const ttlMs = infra
    ? Math.max(60000, infra.revertAt - Date.now())
    : CONFIG_OVERRIDE_TTL_MS;

  const prior = configOverrides.get(runRef);
  if (prior && prior.timer) clearTimeout(prior.timer);
  while (!prior && configOverrides.size >= CONFIG_OVERRIDE_MAX) {
    const keys = Array.from(configOverrides.keys());
    // Prefer evicting overrides whose run has no live incident so an open
    // run's mitigation is only dropped as a last resort.
    const evict = keys.find((k) => !scopedInfra.has(k)) || keys[0];
    clearOncallConfigOverride(evict, 'override registry at capacity');
  }
  setScopedConfig(runRef, applied);
  const timer = setTimeout(() => {
    clearOncallConfigOverride(runRef, 'override TTL elapsed');
  }, ttlMs);
  if (timer.unref) timer.unref();
  configOverrides.set(runRef, {
    fields: { ...((prior && prior.fields) || {}), ...applied },
    timer,
    expiresAt: Date.now() + ttlMs,
  });
  logger.info('On-Call config override set', { runRef, applied, ttlMs });
  return {
    ok: true,
    runRef,
    applied,
    fields: configOverrides.get(runRef).fields,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}

/**
 * Effective compliance config for the caller's run (or an explicit runRef):
 * shipped defaults with any live override applied.
 */
function getOncallConfigView(explicitRunRef) {
  const runRef = explicitRunRef || getOncallRunRef();
  const entry = runRef ? configOverrides.get(runRef) : null;
  const override = entry ? entry.fields : (explicitRunRef ? {} : getScopedConfig());
  return {
    runRef: runRef || null,
    defaults: { ...COMPLIANCE_DEFAULTS },
    override,
    effective: { ...COMPLIANCE_DEFAULTS, ...override },
    overrideExpiresAt: entry ? new Date(entry.expiresAt).toISOString() : null,
  };
}

function isPlainObject(value) {
  return value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null);
}

module.exports = {
  ALERT_SCENARIOS,
  postOncallAlert,
  postOncallBugReport,
  INFRA_INCIDENTS,
  postOncallInfraIncident,
  getInfraState,
  isPlainObject,
  buildOncallSessionPrompt,
  setOncallConfigOverride,
  getOncallConfigView,
};
