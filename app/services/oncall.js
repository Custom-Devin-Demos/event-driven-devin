const crypto = require('crypto');
const axios = require('axios');
const logger = require('../telemetry/logger');
const { postMessage, lookupSlackUserByEmail, findChannelByNameFragment, joinChannel, postPersonaMessage } = require('./slack');
const { getScenario, getOncallRunRef, setScopedScenario, clearScopedScenario } = require('../incidentModes');
const { releaseAccumulatedEntitlements } = require('./oncall-verticals/hightech');

/**
 * On-Call demo service.
 *
 * Posts alert cards, human-style bug reports, and incident bursts to the
 * dedicated On-Call Slack channels. Alert-only by design: nothing here
 * triggers a Devin session — the On-Call responders listening to the
 * channels pick the messages up on their own.
 *
 * Channels/token are configurable via env:
 *   SLACK_ONCALL_ALERTS_CHANNEL_ID — alert + incident channel (#oncall-alerts)
 *   SLACK_ONCALL_BUGS_CHANNEL_ID   — bug report channel (#oncall-bugs)
 *   SLACK_ONCALL_BOT_TOKEN         — bot token override (default: SLACK_BOT_TOKEN)
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
};

/**
 * Canned human-style bug reports for the Bug Triage Responder demo.
 * Deliberately fuzzy: they describe symptoms, not stack traces, so the
 * responder has to reproduce and dig.
 */
const BUG_CATALOG = {
  banking: [
    {
      id: 'banking-transfer-slow',
      label: 'Transfers extremely slow',
      sev: 'High',
      text: 'Hey team — customers are saying fund transfers in online banking take forever now. The spinner sits there for a good ten seconds on every single transfer before it finally goes through. Any amount, both accounts, every time. Support ticket volume on this is climbing today.',
    },
    {
      id: 'banking-payroll-cutoff',
      label: 'Payroll batch missing cutoff',
      sev: 'Critical',
      text: "Escalating from treasury ops: our payroll batch runs transfers one after another and each one now takes ~10 seconds, so the batch is going to miss the 2pm wire cutoff. Nothing errors — it's just painfully slow, and it was fine on Friday. Please treat as urgent.",
    },
  ],
  insurance: [
    {
      id: 'insurance-claim-timeout',
      label: 'Claim submissions timing out',
      sev: 'High',
      text: "Support escalation: policyholders can't file claims through the portal. The claim form hangs for close to ten seconds and then fails with a gateway timeout. One customer tried 4 times with different claim types — same hang, same timeout.",
    },
    {
      id: 'insurance-storm-claims',
      label: 'Storm-damage claims blocked',
      sev: 'Critical',
      text: 'We have a wave of storm-damage claims coming in after last night and NONE of them are going through the portal — every submission spins and then dies with a timeout error. Adjusters are telling customers to fax paperwork like it is 1995.',
    },
  ],
  hightech: [
    {
      id: 'hightech-provision-slowdown',
      label: 'Provisioning noticeably slow',
      sev: 'Medium',
      text: "Sales flagged that provisioning trial licenses is painfully slow — every request sits for seven or eight seconds before completing. Not failing, just slow, and it seems to get a little worse with every license we add.",
    },
    {
      id: 'hightech-renewal-slow',
      label: 'Renewal seat expansion crawling',
      sev: 'High',
      text: 'Customer success here — our biggest renewal of the quarter is trying to add 200 seats and every provisioning call in the admin console sits there for ages before completing. They renew Friday and their admin is convinced our platform is falling over.',
    },
  ],
  telco: [
    {
      id: 'telco-upgrade-slow',
      label: 'Plan upgrades very slow',
      sev: 'Medium',
      text: 'Getting complaints in the app store reviews that plan changes take forever now — "hit upgrade to Ultra and stared at a spinner for ten seconds". People assume it failed and hit it again. This seems to have started after the plan lineup was refreshed.',
    },
    {
      id: 'telco-family-plan',
      label: 'Family plan upgrade crawling',
      sev: 'High',
      text: "My whole family is on the Plus plan and I upgraded us to Ultra last night. Every line I upgraded sat on the confirm screen for close to ten seconds — I honestly thought it was frozen. It did go through eventually, but something is clearly wrong.",
    },
  ],
};

function findBugTemplate(templateId) {
  if (!templateId) return null;
  for (const entries of Object.values(BUG_CATALOG)) {
    const match = entries.find((t) => t.id === templateId);
    if (match) return match;
  }
  return null;
}

// Back-compat: legacy scenarioId (product area) → first template's text.
const BUG_REPORTS = Object.fromEntries(
  Object.entries(BUG_CATALOG).map(([area, entries]) => [area, entries[0].text]),
);

function resolveOncallEnv() {
  return {
    token: process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN,
    alertsChannel: process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
    bugsChannel: process.env.SLACK_ONCALL_BUGS_CHANNEL_ID,
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

function contextBlock(service, triggeredBy) {
  const parts = [`Service: \`${service || 'checkout-api'}\``, new Date().toISOString()];
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
function buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy, skin }) {

  const brand = skin ? skin.company : scenario.brand;
  const lines = [
    `:rotating_light: *[Triggered] ${scenario.monitor}*`,
    '',
    `*Service:* ${scenario.service} (${brand})`,
    skin ? `*Demo page:* ${DEMO_BASE_URL()}/oncall/c/${skin.slug} — reproduce the symptom on this branded page` : null,
    `*Endpoint:* ${scenario.endpoint}`,
    `*Metric value:* ${scenario.metricValue} | *Threshold:* ${scenario.threshold} | *Baseline:* ${scenario.baseline}`,
    `*Monitor query:* \`${scenario.metricQuery}\``,
    `*Owner:* ${scenario.owner} — demo persona, do not resolve to a real Slack user`,
    runRef ? `*Incident Ref:* ${runRef}` : null,
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
    '',
    `Env: production | Release: ${scenario.release}`,
    `Events: ${events} | First: ${firstSeen.toISOString()} | Last: ${now.toISOString()}`,
    '',
    `*Symptom:* ${scenario.symptom}`,
    `*Impact:* ${scenario.impact}`,
    `Repo: ${REPO_URL}`,
  ];

  return lines.filter((l) => l !== null).join('\n');
}

/**
 * Post an alert card for the given scenario to the On-Call alerts channel.
 */
async function postOncallAlert(scenarioId, options = {}) {
  const scenario = ALERT_SCENARIOS[scenarioId];
  if (!scenario) {
    return { ok: false, error: `Unknown scenario: ${scenarioId}` };
  }

  const { token, alertsChannel } = resolveOncallEnv();
  if (!token || !alertsChannel) {
    logger.warn('On-Call alerts channel not configured — skipping alert post');
    return { ok: false, skipped: true, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  const runRef = options.unique !== false ? makeRunRef() : null;
  const triggeredBy = await resolveTriggeredBy(token, options.devinEmail);
  const now = new Date();
  const firstSeen = new Date(now.getTime() - (5 + Math.floor(Math.random() * 20)) * 60000);
  const events = 3 + Math.floor(Math.random() * 12);
  const skin = options.skin || null;
  const text = buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy, skin });
  const brand = skin ? skin.company : scenario.brand;
  const blocks = [
    headerBlock(`:rotating_light: [Triggered] ${scenario.monitor}`),
    ...fieldPairs([
      ['Service', `${scenario.service} (${brand})`],
      ['Endpoint', scenario.endpoint],
      ['Metric value', scenario.metricValue],
      ['Threshold', scenario.threshold],
      ['Baseline', scenario.baseline],
      ['Release', scenario.release],
      ['Events', `${events} | First: ${firstSeen.toISOString()}`],
      ['Owner', `${scenario.owner} — demo persona, do not resolve to a real Slack user`],
      runRef ? ['Incident Ref', runRef] : null,
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    mrkdwnSection(`*Monitor query:*\n\`\`\`${scenario.metricQuery}\`\`\``),
    mrkdwnSection(
      `*Symptom:* ${scenario.symptom}\n*Impact:* ${scenario.impact}\n` +
      (skin ? `*Demo page:* ${DEMO_BASE_URL()}/oncall/c/${skin.slug} — reproduce the symptom on this branded page\n` : '') +
      `Repo: ${REPO_URL}`
    ),
    datadogActions(),
    contextBlock(scenario.service, triggeredBy),
  ];
  const ts = await postMessage(token, alertsChannel, text, blocks);
  logger.info('On-Call alert posted', { scenario: scenarioId, channel: alertsChannel, ts });
  return { ok: true, ts, channel: alertsChannel };
}

/**
 * Post a human-style bug report to the On-Call bugs channel.
 * Accepts either a canned scenario id or free-form text.
 */
async function postOncallBugReport({ scenarioId, templateId, text, reporter, severity, productArea, devinEmail, supportCenter }) {
  const { token, bugsChannel } = resolveOncallEnv();

  const template = findBugTemplate(templateId);
  const body = text || (template && template.text) || BUG_REPORTS[scenarioId];
  if (!body) {
    return { ok: false, error: `No bug report text and unknown scenario: ${scenarioId}` };
  }

  // Backend-symptom templates activate the matching infra degradation so the
  // Bug Triage Responder's repro steps genuinely reproduce. The template id is
  // resolved server-side against the catalog — only known kinds can activate.
  let activated = null;
  const runRef = makeRunRef();
  if (template && template.infraKind && INFRA_INCIDENTS[template.infraKind]) {
    supersedePriorRun(runRef);
    if (activateInfraIncident(template.infraKind, INFRA_WINDOW_MS, runRef)) {
      activated = template.infraKind;
    }
  }

  if (!token || !bugsChannel) {
    logger.warn('On-Call bugs channel not configured — skipping bug report post', { activated });
    return {
      ok: false,
      skipped: true,
      error: 'SLACK_ONCALL_BUGS_CHANNEL_ID or bot token not configured',
      activated,
      runRef: activated ? runRef : null,
      windowMinutes: activated ? Math.round(INFRA_WINDOW_MS / 60000) : null,
    };
  }

  const triggeredBy = await resolveTriggeredBy(token, devinEmail);
  let message = triggeredBy ? `${body}\nTriggered by: ${triggeredBy}` : body;
  let blocks = null;
  if (reporter || severity || productArea) {
    const reportedBy = reporter && (reporter.name || reporter.email)
      ? [reporter.name, reporter.email && `<${reporter.email}>`].filter(Boolean).join(' ')
      : null;
    const centerName = supportCenter || 'Acme Support Center';
    const centerSlug = centerName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    message = [
      `:inbox_tray: New support ticket — ${centerName}`,
      reportedBy ? `Reported by: ${reportedBy}` : null,
      productArea ? `Product area: ${productArea}` : null,
      severity ? `Severity: ${severity}` : null,
      triggeredBy ? `Triggered by: ${triggeredBy}` : null,
      '',
      body,
    ].filter((l) => l !== null).join('\n');
    blocks = [
      headerBlock(`:inbox_tray: New support ticket — ${centerName}`),
      ...fieldPairs([
        reportedBy ? ['Reported by', reportedBy] : null,
        productArea ? ['Product area', productArea] : null,
        severity ? ['Severity', severity] : null,
      ]),
      mrkdwnSection(body),
      contextBlock(centerSlug, triggeredBy),
    ];
  }

  let ts;
  try {
    ts = await postMessage(token, bugsChannel, message, blocks);
  } catch (error) {
    // Keep observable state consistent with what was announced: if the ticket
    // never posted, don't leave the app silently degraded for the full window.
    if (activated) revertScopedInfra(runRef, 'bug report post failed');
    throw error;
  }
  logger.info('On-Call bug report posted', {
    scenario: scenarioId || 'custom',
    template: templateId || null,
    activated,
    channel: bugsChannel,
    ts,
  });
  return {
    ok: true,
    ts,
    channel: bugsChannel,
    activated,
    runRef: activated ? runRef : null,
    windowMinutes: activated ? Math.round(INFRA_WINDOW_MS / 60000) : null,
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
const SEV1_WINDOW_MS = envNumber(process.env.ONCALL_SEV1_WINDOW_MS, 30 * 60 * 1000);

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
    stopSev1Probe(prior, 'superseded by a new run from the same browser');
    stopSev1Chatter(prior, 'superseded by a new run from the same browser');
  }
}

function revertScopedInfra(runRef, reason) {
  const entry = scopedInfra.get(runRef);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  if (entry.scenario) clearScopedScenario(runRef);
  scopedInfra.delete(runRef);
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
  const ownerLine = `${incident.owner} — demo persona, do not resolve to a real Slack user`;
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
 * SEV-1 incident stories. Each is backed by one of the on-call vertical
 * services' real, always-present performance defects — the same code paths
 * the alert demos exercise — so the investigation lands on genuine
 * root-causable code. While the incident is open, a synthetic probe loop
 * drives real traffic through the affected endpoint so logs, traces, and
 * metrics record the failure as it happens.
 */
const SEV1_INCIDENTS = {
  'banking-transfers': {
    vertical: 'banking',
    label: 'Fund transfers degraded — banking-api p95 10x baseline',
    title: 'Fund transfers degraded — p95 latency 10x baseline on banking-api',
    summary: 'POST /api/oncall/banking/transfer p95 at ~9.6s against a ~280ms baseline. Transfers eventually succeed but every submission hangs ~10s; support reports rising complaint volume.',
    probeBody: { amount: 250 },
  },
  'insurance-claims': {
    vertical: 'insurance',
    label: 'Claim submissions failing — insurance-api 504s',
    title: 'Claim submissions failing — 504 Gateway Timeout on insurance-api',
    summary: 'POST /api/oncall/insurance/claim hangs ~8s then fails with 504 on ~100% of submissions. Policyholders cannot file claims through the portal.',
    probeBody: { claimType: 'collision', amount: 4200 },
  },
  'licensing-latency': {
    vertical: 'hightech',
    label: 'License provisioning slowdown — licensing-api latency + RSS climbing',
    title: 'License provisioning slowdown — latency and memory climbing on licensing-api',
    summary: 'POST /api/oncall/licenses/provision p95 at ~6.8s and climbing under sustained traffic; process RSS trends up alongside it. Every provisioning call is slow and getting slower.',
    probeBody: { seats: 25 },
    onProbeStop: releaseAccumulatedEntitlements,
  },
  'telco-upgrades': {
    vertical: 'telco',
    label: 'Plan upgrades degraded — telco-api latency scaling with catalog',
    title: 'Plan upgrades degraded — p95 latency scaling with catalog size on telco-api',
    summary: 'POST /api/oncall/telco/upgrade p95 at ~7.9s against a ~300ms baseline since the plan-catalog refresh. Subscribers wait ~8s on every plan change; upgrade completion rate is dropping.',
    probeBody: {},
  },
};

/**
 * Synthetic probe traffic for open SEV-1 incidents. Requests run
 * sequentially per incident (a tick is only scheduled after the previous
 * request completes), so slow endpoints never pile up, and the number of
 * concurrent probe loops is bounded. Failures are the point: the probe's
 * requests hit the degraded endpoint for real, so telemetry shows genuine
 * evidence during the window.
 */
const SEV1_PROBE_INTERVAL_MS = envNumber(process.env.ONCALL_SEV1_PROBE_INTERVAL_MS, 10000);
const SEV1_PROBE_MAX = envNumber(process.env.ONCALL_SEV1_PROBE_MAX, 25);
const activeSev1Probes = new Map();

/**
 * Phased evidence: probe volume ramps through the incident window instead of
 * arriving at full rate from minute zero, so the telemetry picture develops
 * over time — early on only sparse, ambiguous failures exist; the failure
 * signature only becomes statistically visible mid-incident. An investigator
 * writing an RCA as evidence lands revises it across the phases rather than
 * concluding everything from the opening snapshot.
 *
 * Phase boundaries are fractions of the incident window (at the default
 * 30-minute window: 0–5, 5–10, 10–15, 15–30 minutes); each phase multiplies
 * the base probe interval.
 */
const SEV1_PROBE_PHASE_BOUNDS = [1 / 6, 1 / 3, 1 / 2];
const SEV1_PROBE_PHASE_MULTIPLIERS = [6, 3, 1.5, 1];

function sev1ProbePhase(elapsedMs, windowMs) {
  for (let i = 0; i < SEV1_PROBE_PHASE_BOUNDS.length; i++) {
    if (elapsedMs < windowMs * SEV1_PROBE_PHASE_BOUNDS[i]) return i;
  }
  return SEV1_PROBE_PHASE_BOUNDS.length;
}

function startSev1Probe(runRef, story, windowMs = SEV1_WINDOW_MS) {
  stopSev1Probe(runRef, 'restarted');
  if (activeSev1Probes.size >= SEV1_PROBE_MAX) {
    logger.warn('SEV-1 probe cap reached — incident declared without synthetic traffic', {
      runRef,
      cap: SEV1_PROBE_MAX,
    });
    return false;
  }
  const scenario = ALERT_SCENARIOS[story.vertical];
  const url = `http://127.0.0.1:${process.env.PORT || 3000}${scenario.oncallApiPath}`;
  const probe = { stopped: false, timer: null, story, phase: 0 };
  const startedAt = Date.now();
  const stopAt = startedAt + windowMs;

  const tick = async () => {
    if (probe.stopped) return;
    const started = Date.now();
    let status;
    try {
      const response = await axios.post(url, story.probeBody || {}, {
        timeout: 30000,
        validateStatus: () => true,
        // Marked like real synthetic-monitoring traffic so downstream services
        // can distinguish probe requests from user requests.
        headers: { 'x-synthetic-monitor': runRef },
      });
      status = response.status;
    } catch (error) {
      status = error.code || 'error';
    }
    logger.info('SEV-1 synthetic probe', {
      runRef,
      endpoint: scenario.endpoint,
      status,
      ms: Date.now() - started,
    });
    if (probe.stopped) return;
    if (Date.now() >= stopAt) {
      stopSev1Probe(runRef, 'window elapsed');
      return;
    }
    const phase = sev1ProbePhase(Date.now() - startedAt, windowMs);
    if (phase !== probe.phase) {
      probe.phase = phase;
      logger.info('SEV-1 synthetic probe phase change', {
        runRef,
        phase: phase + 1,
        intervalMs: SEV1_PROBE_INTERVAL_MS * SEV1_PROBE_PHASE_MULTIPLIERS[phase],
      });
    }
    probe.timer = setTimeout(tick, SEV1_PROBE_INTERVAL_MS * SEV1_PROBE_PHASE_MULTIPLIERS[phase]);
    if (probe.timer.unref) probe.timer.unref();
  };

  activeSev1Probes.set(runRef, probe);
  probe.timer = setTimeout(tick, 1000);
  if (probe.timer.unref) probe.timer.unref();
  logger.info('SEV-1 synthetic probe started', {
    runRef,
    endpoint: scenario.endpoint,
    baseIntervalMs: SEV1_PROBE_INTERVAL_MS,
    phases: SEV1_PROBE_PHASE_MULTIPLIERS.length,
  });
  return true;
}

function stopSev1Probe(runRef, reason) {
  const probe = activeSev1Probes.get(runRef);
  if (!probe) return;
  probe.stopped = true;
  if (probe.timer) clearTimeout(probe.timer);
  activeSev1Probes.delete(runRef);
  logger.info('SEV-1 synthetic probe stopped', { runRef, reason });
  // Release state the probe traffic accumulated (e.g. hightech entitlement
  // snapshots), but only once no other live probe is still driving the same
  // vertical.
  const story = probe.story;
  if (story && story.onProbeStop) {
    const stillActive = Array.from(activeSev1Probes.values()).some(
      (p) => p.story && p.story.vertical === story.vertical,
    );
    if (!stillActive) story.onProbeStop();
  }
}

/**
 * Persona chatter for SEV-1 incident channels. Once Datadog creates the
 * incident channel, the bot joins it and drips a short, scenario-consistent
 * responder conversation (detection → confirmation → paging → impact) under
 * persona display names, so the channel reads like a live response.
 * Requires bot scopes: channels:read, channels:join, chat:write.customize.
 */
const SEV1_CHATTER_LOOKUP_INTERVAL_MS = 15000;
const SEV1_CHATTER_LOOKUP_MAX_ATTEMPTS = 12;
const activeSev1Chatter = new Map();

function buildSev1Chatter(story) {
  const scenario = ALERT_SCENARIOS[story.vertical];
  const sre = { username: 'Alex Kim (SRE)', icon: ':technologist:' };
  const owner = { username: scenario.owner, icon: ':computer:' };
  const support = { username: 'Priya Nair (Support Lead)', icon: ':headphones:' };
  // Timed against the phased probe schedule: the conversation develops with
  // the telemetry — early messages are ambiguous, a plausible-but-wrong
  // hypothesis lands mid-incident and is later disconfirmed, and the closing
  // observations describe the pattern the sustained probe volume has made
  // visible. Each drop gives an investigator maintaining a live RCA a
  // concrete reason to revise it. Symptoms and observations only — never the
  // root cause. `at` is the fraction of the incident window at which the
  // message posts, so timings track the probe phases at any window length.
  const byVertical = {
    banking: [
      { ...sre, at: 0.003, text: `Seeing p95 on \`${scenario.endpoint}\` at ~9.6s, baseline is ~280ms. Only a handful of datapoints so far — could be a blip.` },
      { ...support, at: 0.033, text: 'Support queue is filling up — customers reporting transfers “stuck on a spinner” for ~10 seconds before going through.' },
      { ...owner, at: 0.1, text: 'First guess: the payments gateway is slow again — they had an incident last month with the same smell. Reaching out to their on-call.' },
      { ...sre, at: 0.2, text: 'More traffic hitting the endpoint now — latency is flat at ~9-10s per request regardless of load. Not a blip.' },
      { ...support, at: 0.267, text: 'Complaint volume still climbing. No failed transfers though — everything completes, just painfully slow.' },
      { ...owner, at: 0.367, text: 'Gateway team came back: their dashboards are clean, sub-100ms on every call from us. Whatever this is, it’s on our side.' },
      { ...sre, at: 0.467, text: 'Traces show the request pinned server-side in the transfer path, not the DB and not the gateway. Escalating fully — this needs a code-level look.' },
      { ...owner, at: 0.567, text: 'With more traces in: the slow span breaks into a series of similar sub-steps back-to-back, each a few hundred ms. Pulling a waterfall for one transfer now.' },
    ],
    insurance: [
      { ...sre, at: 0.003, text: `5xx monitor firing on \`${scenario.endpoint}\` — a few 504s after an ~8s hang. Sample size is small, watching.` },
      { ...support, at: 0.033, text: 'Two policyholders so far reporting claim submissions spinning then erroring. Might be isolated.' },
      { ...owner, at: 0.1, text: 'Betting this is the adjudication vendor — their status page showed elevated latency earlier this week. Asking them to check.' },
      { ...sre, at: 0.2, text: 'Volume picking up and it’s not isolated — essentially 100% of submissions now failing 504 after ~8s. Declaring hard outage on the claims path.' },
      { ...support, at: 0.267, text: 'Complaint volume spiking. Quotes and policy reads are fine — only claim submission is broken.' },
      { ...owner, at: 0.367, text: 'Vendor came back clean — their API is answering fast and error-free from their side. So the 504s are being manufactured somewhere between us and them.' },
      { ...sre, at: 0.467, text: 'Interesting: every failure takes almost exactly the same ~7.5s before the 504. That uniformity doesn’t look like a flaky dependency.' },
      { ...owner, at: 0.567, text: 'Log timelines show each failed request making several similar dependency attempts back-to-back before giving up. Pulling the full request timeline for one claim.' },
    ],
    hightech: [
      { ...sre, at: 0.003, text: `p95 on \`${scenario.endpoint}\` at ~6.8s. Only sparse traffic so far — hard to tell if it’s trending or noise.` },
      { ...support, at: 0.033, text: 'One enterprise customer flagging slow seat provisioning — activation that used to be instant now takes ~7 seconds per license.' },
      { ...owner, at: 0.1, text: 'Could be the license DB — we’ve seen slow provisioning before when its connection pool saturates. Checking DB metrics.' },
      { ...sre, at: 0.2, text: 'With sustained traffic it’s unambiguous: each request is a bit slower than the last, and process RSS is climbing in step with latency.' },
      { ...support, at: 0.267, text: 'More orgs reporting it now. Symptom is consistent — provisioning works, just slower every time.' },
      { ...owner, at: 0.367, text: 'DB is exonerated — query times flat, pool healthy. The slowdown is inside the licensing service itself.' },
      { ...sre, at: 0.467, text: 'Memory trend is monotonic — no plateau, no GC recovery. If this keeps going we’re headed for an OOM restart.' },
      { ...owner, at: 0.567, text: 'Someone grab a heap snapshot before and after a few provisioning calls — want to see what’s growing before we restart anything and lose the evidence.' },
    ],
    telco: [
      { ...sre, at: 0.003, text: `p95 on \`${scenario.endpoint}\` at ~7.9s vs ~300ms baseline. Few datapoints yet — flagging early.` },
      { ...support, at: 0.033, text: 'Seeing a dip in upgrade completions on the dashboard — a few subscribers abandoning plan changes mid-flow.' },
      { ...owner, at: 0.1, text: 'The billing provider deployed yesterday — suspicious timing. Asking them if plan-change calls got slower on their end.' },
      { ...sre, at: 0.2, text: 'Traffic is up and the picture is consistent: every upgrade pays the same ~8s cost, uniform across subscribers and regions. Not a hot shard.' },
      { ...support, at: 0.267, text: 'Upgrade completion rate still dropping. Plan browsing and billing views are snappy — only the upgrade action is slow.' },
      { ...owner, at: 0.367, text: 'Billing provider is clean — their call latencies are unchanged pre/post deploy. Also worth noting the plan-catalog refresh landed around when this started.' },
      { ...sre, at: 0.467, text: 'The catalog refresh roughly tripled the number of active plans. If upgrade cost scales with catalog size, that would fit both the timing and the uniformity.' },
      { ...owner, at: 0.567, text: 'Pulling a profile of one upgrade request — want to see whether the time is in rating, rescoring, or persistence before we touch the catalog.' },
    ],
  };
  return byVertical[story.vertical] || [];
}

function stopSev1Chatter(runRef, reason) {
  const chatter = activeSev1Chatter.get(runRef);
  if (!chatter) return;
  chatter.stopped = true;
  for (const timer of chatter.timers) clearTimeout(timer);
  activeSev1Chatter.delete(runRef);
  logger.info('SEV-1 persona chatter stopped', { runRef, reason });
}

function startSev1Chatter(runRef, story, publicId, windowMs = SEV1_WINDOW_MS) {
  stopSev1Chatter(runRef, 'restarted');
  const { token } = resolveOncallEnv();
  if (!token || !publicId) return false;
  const script = buildSev1Chatter(story);
  if (!script.length) return false;

  const chatter = { stopped: false, timers: [] };
  activeSev1Chatter.set(runRef, chatter);
  // Datadog names incident channels from a template that includes
  // `incident-<publicId>-` (e.g. `sev-1-incident-25-<slugified title>`).
  // Matching on the severity-agnostic marker survives template tweaks.
  const marker = `incident-${publicId}-`;

  let attempts = 0;
  const locate = async () => {
    if (chatter.stopped) return;
    attempts++;
    let channel = null;
    try {
      channel = await findChannelByNameFragment(token, marker);
    } catch (error) {
      logger.warn('SEV-1 chatter channel lookup failed', { runRef, error: error.message });
    }
    if (chatter.stopped) return;
    if (!channel) {
      if (attempts >= SEV1_CHATTER_LOOKUP_MAX_ATTEMPTS) {
        logger.warn('SEV-1 incident channel never appeared — skipping persona chatter', { runRef, marker });
        chatter.stopped = true;
        activeSev1Chatter.delete(runRef);
        return;
      }
      const timer = setTimeout(locate, SEV1_CHATTER_LOOKUP_INTERVAL_MS);
      if (timer.unref) timer.unref();
      chatter.timers.push(timer);
      return;
    }

    try {
      await joinChannel(token, channel.id);
    } catch (error) {
      // Only Slack API errors that cannot succeed on retry (missing scope,
      // archived/missing channel, private channel) are permanent; everything
      // else (ratelimited, internal_error, transport failures, timeouts,
      // 429s/5xx) retries on the same bounded schedule.
      const permanent =
        /Slack API error: (missing_scope|invalid_auth|account_inactive|token_revoked|is_archived|channel_not_found|method_not_supported_for_channel_type)/.test(
          error.message,
        );
      logger.warn('SEV-1 chatter could not join incident channel', {
        runRef,
        channel: channel.name,
        error: error.message,
        ...(error.message.includes('missing_scope')
          ? { hint: 'bot needs the channels:join scope' }
          : {}),
      });
      if (chatter.stopped) return;
      if (permanent || attempts >= SEV1_CHATTER_LOOKUP_MAX_ATTEMPTS) {
        chatter.stopped = true;
        activeSev1Chatter.delete(runRef);
        return;
      }
      const timer = setTimeout(locate, SEV1_CHATTER_LOOKUP_INTERVAL_MS);
      if (timer.unref) timer.unref();
      chatter.timers.push(timer);
      return;
    }
    if (chatter.stopped) return;

    logger.info('SEV-1 persona chatter scheduled', { runRef, channel: channel.name, messages: script.length });
    for (const line of script) {
      const timer = setTimeout(async () => {
        if (chatter.stopped) return;
        try {
          await postPersonaMessage(token, channel.id, line.text, line.username, line.icon);
        } catch (error) {
          logger.warn('SEV-1 persona message failed', { runRef, error: error.message });
        }
      }, Math.round(line.at * windowMs));
      if (timer.unref) timer.unref();
      chatter.timers.push(timer);
    }
  };

  const firstTimer = setTimeout(locate, SEV1_CHATTER_LOOKUP_INTERVAL_MS);
  if (firstTimer.unref) firstTimer.unref();
  chatter.timers.push(firstTimer);
  return true;
}

function ddIncidentEnv() {
  return {
    apiKey: process.env.DD_API_KEY,
    appKey: process.env.DD_INCIDENT_APP_KEY || process.env.DD_APPLICATION_KEY,
    site: process.env.DD_SITE || 'us5.datadoghq.com',
  };
}

function ddHeaders({ apiKey, appKey }) {
  return {
    'DD-API-KEY': apiKey,
    'DD-APPLICATION-KEY': appKey,
    'Content-Type': 'application/json',
  };
}

/**
 * Declare a SEV-1 incident in Datadog Incident Management.
 * With the Datadog Slack app installed and "Create Slack channels for
 * incidents" enabled, Datadog creates the incident channel itself.
 */
async function declareDatadogIncident({ title, summary, runRef, triggeredBy }) {
  const env = ddIncidentEnv();
  if (!env.apiKey || !env.appKey) {
    return null;
  }

  const response = await axios.post(
    `https://api.${env.site}/api/v2/incidents`,
    {
      data: {
        type: 'incidents',
        attributes: {
          // Severity is carried by the field (and the channel-name template);
          // keeping it out of the title avoids a doubled-up channel name.
          title: `${title} (${runRef})`,
          customer_impacted: true,
          fields: {
            severity: { type: 'dropdown', value: 'SEV-1' },
            summary: {
              type: 'textbox',
              value: `${summary} Incident Ref: ${runRef}.${triggeredBy ? ` Declared by: ${triggeredBy}.` : ''} Repo: ${REPO_URL}`,
            },
          },
        },
      },
    },
    { headers: ddHeaders(env), timeout: 10000 },
  );

  const incident = response.data && response.data.data;
  if (!incident || !incident.id) {
    return null;
  }
  return {
    id: incident.id,
    publicId: incident.attributes && incident.attributes.public_id,
  };
}

/**
 * Resolve a Datadog incident by id. The Datadog Slack integration then
 * auto-archives the incident channel on its own schedule.
 */
async function resolveDatadogIncident(incidentId) {
  const env = ddIncidentEnv();
  if (!env.apiKey || !env.appKey || !incidentId) return false;
  await axios.patch(
    `https://api.${env.site}/api/v2/incidents/${incidentId}`,
    {
      data: {
        id: incidentId,
        type: 'incidents',
        attributes: { fields: { state: { type: 'dropdown', value: 'resolved' } } },
      },
    },
    { headers: ddHeaders(env), timeout: 10000 },
  );
  return true;
}

/**
 * Live registry of declared SEV-1 incidents, keyed by runRef, powering the
 * /oncall page status and the auto-resolve timers. Each demo click is an
 * independent incident with its own channel and lifecycle.
 */
const activeSev1 = new Map();
const SEV1_HISTORY_MAX = 20;

function pruneSev1() {
  while (activeSev1.size > SEV1_HISTORY_MAX) {
    const keys = Array.from(activeSev1.keys());
    const evict = keys.find((k) => activeSev1.get(k).status === 'resolved') || keys[0];
    activeSev1.delete(evict);
  }
}

const SEV1_RESOLVE_MAX_ATTEMPTS = 4;
const SEV1_RESOLVE_RETRY_MS = 30000;

/**
 * Trigger a SEV-1 incident. Preferred path: activate the matching real
 * degradation and declare a real Datadog incident. Datadog's Slack
 * integration creates the incident channel and Devin's native incident
 * auto-join picks it up from the channel-name prefix — the app never touches
 * the channel itself. The incident auto-resolves when the degradation window
 * ends. Fallback (Datadog keys not configured): post a SEV-1 style message
 * to the alerts channel.
 */
async function postOncallIncident(options = {}) {
  const runRef = makeRunRef();
  const { token, alertsChannel } = resolveOncallEnv();
  const hasKind = Object.prototype.hasOwnProperty.call(SEV1_INCIDENTS, options.kind);
  if (options.kind != null && options.kind !== '' && !hasKind) {
    return { ok: false, error: `Unknown incident kind: ${options.kind}` };
  }
  const kind = hasKind ? options.kind : 'banking-transfers';
  const story = SEV1_INCIDENTS[kind];

  let incident = null;
  try {
    incident = await declareDatadogIncident({
      title: story.title,
      summary: story.summary,
      runRef,
      triggeredBy: options.devinEmail && EMAIL_RE.test(options.devinEmail) ? options.devinEmail : null,
    });
  } catch (error) {
    logger.error('Datadog incident declaration failed — falling back to Slack post', {
      error: error.message,
    });
  }

  if (incident) {
    supersedePriorRun(runRef);
    startSev1Probe(runRef, story);
    startSev1Chatter(runRef, story, incident.publicId);
    const entry = {
      runRef,
      kind,
      label: story.label,
      summary: story.summary,
      id: incident.id,
      publicId: incident.publicId,
      declaredAt: Date.now(),
      resolveAt: Date.now() + SEV1_WINDOW_MS,
      status: 'declared',
    };
    activeSev1.set(runRef, entry);
    pruneSev1();

    const scheduleResolve = (delayMs, attempt) => {
      const timer = setTimeout(async () => {
        stopSev1Probe(runRef, 'incident window elapsed');
        stopSev1Chatter(runRef, 'incident window elapsed');
        try {
          const resolved = await resolveDatadogIncident(entry.id);
          if (!resolved) {
            logger.error('SEV-1 auto-resolve impossible — Datadog incident env not configured', { runRef });
            entry.status = 'resolve_failed';
            return;
          }
          entry.status = 'resolved';
          logger.info('SEV-1 incident auto-resolved', { runRef, publicId: entry.publicId });
        } catch (error) {
          logger.error('SEV-1 auto-resolve failed', { runRef, attempt, error: error.message });
          if (attempt < SEV1_RESOLVE_MAX_ATTEMPTS) {
            scheduleResolve(SEV1_RESOLVE_RETRY_MS * attempt, attempt + 1);
          } else {
            entry.status = 'resolve_failed';
          }
        }
      }, delayMs);
      if (timer.unref) timer.unref();
    };
    scheduleResolve(SEV1_WINDOW_MS, 1);

    logger.info('On-Call Datadog incident declared', { runRef, kind, ...incident });
    return {
      ok: true,
      provider: 'datadog',
      runRef,
      kind,
      label: story.label,
      windowMinutes: Math.round(SEV1_WINDOW_MS / 60000),
      ...incident,
    };
  }

  if (!token || !alertsChannel) {
    logger.warn('On-Call alerts channel not configured — skipping incident post');
    return { ok: false, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  // Fallback path (Datadog not configured): the degradation is real code on
  // the vertical endpoint; start the probe loop so telemetry records it.
  supersedePriorRun(runRef);
  startSev1Probe(runRef, story);

  const scenario = ALERT_SCENARIOS[story.vertical];
  const text = [
    `:fire: *SEV-1 — ${story.label}*`,
    '',
    `*Incident Ref:* ${runRef}`,
    `*Summary:* ${story.summary}`,
    `*Env:* production | *Service:* ${scenario.service}`,
    `*Endpoint:* ${scenario.endpoint}`,
    '',
    `Repo: ${REPO_URL}`,
  ].join('\n');
  const triggeredBy = await resolveTriggeredBy(token, options.devinEmail);
  const fullText = triggeredBy ? `${text}\nTriggered by: ${triggeredBy}` : text;

  let ts;
  try {
    ts = await postMessage(token, alertsChannel, fullText);
  } catch (error) {
    // Keep observable state consistent with what was announced: if the SEV-1
    // never posted, don't keep driving probe traffic for the full window.
    stopSev1Probe(runRef, 'SEV-1 fallback post failed');
    throw error;
  }
  logger.info('On-Call incident posted', { channel: alertsChannel, ts, runRef });

  // Register in the live SEV-1 list too; no Datadog incident to resolve, so
  // the entry simply flips to resolved when the degradation window ends.
  const entry = {
    runRef,
    kind,
    label: story.label,
    summary: story.summary,
    id: null,
    publicId: null,
    declaredAt: Date.now(),
    resolveAt: Date.now() + SEV1_WINDOW_MS,
    status: 'declared',
  };
  activeSev1.set(runRef, entry);
  pruneSev1();
  const resolveTimer = setTimeout(() => {
    entry.status = 'resolved';
    stopSev1Probe(runRef, 'incident window elapsed');
  }, SEV1_WINDOW_MS);
  if (resolveTimer.unref) resolveTimer.unref();

  return {
    ok: true,
    ts,
    channel: alertsChannel,
    runRef,
    kind,
    label: story.label,
    windowMinutes: Math.round(SEV1_WINDOW_MS / 60000),
  };
}

/**
 * Live state of declared SEV-1 incidents for the /oncall page.
 */
function getSev1State() {
  // Scoped to the caller, like getInfraState(): only the incident belonging
  // to the request's oncall_run cookie is listed, never someone else's.
  const runRef = getOncallRunRef();
  const entry = runRef ? activeSev1.get(runRef) : null;
  return (entry ? [entry] : []).map((e) => ({
    runRef: e.runRef,
    kind: e.kind,
    label: e.label,
    publicId: e.publicId,
    status: e.status,
    declaredAt: e.declaredAt,
    msRemaining: e.status === 'resolved' ? 0 : Math.max(0, e.resolveAt - Date.now()),
  }));
}

function isActiveSev1ProbeRef(ref) {
  return Boolean(ref) && activeSev1Probes.has(ref);
}

module.exports = {
  ALERT_SCENARIOS,
  BUG_REPORTS,
  BUG_CATALOG,
  postOncallAlert,
  postOncallBugReport,
  INFRA_INCIDENTS,
  postOncallInfraIncident,
  getInfraState,
  postOncallIncident,
  SEV1_INCIDENTS,
  getSev1State,
  isActiveSev1ProbeRef,
};
