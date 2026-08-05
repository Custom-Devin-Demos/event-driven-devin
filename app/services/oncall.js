const axios = require('axios');
const logger = require('../telemetry/logger');
const { postMessage } = require('./slack');
const { setScenario, getScenario } = require('../incidentModes');

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

const REPO_URL = 'https://github.com/COG-GTM/event-driven-devin';

/**
 * Alert scenarios mirroring the real planted bugs in app/services/verticals/.
 * Each entry reproduces the exact error signature a live failure produces so
 * the responder's investigation lands on real code.
 */
const ALERT_SCENARIOS = {
  banking: {
    vertical: 'banking',
    page: 'banking.html',
    apiPath: '/api/banking/transfer',
    owner: 'Jordan Patel (payments-oncall)',
    brand: 'Apex Bank (Online Banking)',
    service: 'acme-demo / banking vertical',
    endpoint: 'POST /api/banking/transfer',
    errorType: 'TypeError',
    errorValue: "Cannot read properties of undefined (reading 'rate')",
    culprit: 'calculateTransferFee (app/services/verticals/banking.js:51)',
    frames: [
      "    at calculateTransferFee (app/services/verticals/banking.js:51:33)",
      "    at processTransfer (app/services/verticals/banking.js:90:17)",
      '    at app/routes/verticals/banking.js',
    ],
    impact: 'Users attempting fund transfers are receiving 500 errors.',
  },
  insurance: {
    vertical: 'insurance',
    page: 'insurance.html',
    apiPath: '/api/insurance/claim',
    owner: 'Morgan Lee (claims-platform-oncall)',
    brand: 'Shield Insurance (Claims Portal)',
    service: 'acme-demo / insurance vertical',
    endpoint: 'POST /api/insurance/claim',
    errorType: 'TypeError',
    errorValue: "Cannot read properties of undefined (reading 'coverage')",
    culprit: 'extractCoverageLimits (app/services/verticals/insurance.js:62)',
    frames: [
      "    at extractCoverageLimits (app/services/verticals/insurance.js:62:29)",
      "    at processClaim (app/services/verticals/insurance.js:87:20)",
      '    at app/routes/verticals/insurance.js',
    ],
    impact: 'Customers submitting claims are receiving 500 errors and cannot file claims.',
  },
  hightech: {
    vertical: 'hightech',
    page: 'hightech.html',
    apiPath: '/api/licenses/provision',
    owner: 'Sam Okafor (licensing-oncall)',
    brand: 'NovaSoft (License Management)',
    service: 'acme-demo / hightech vertical',
    endpoint: 'POST /api/licenses/provision',
    errorType: 'TypeError',
    errorValue: "Cannot read properties of undefined (reading 'pricePerSeat')",
    culprit: 'computeBilling (app/services/verticals/hightech.js:37)',
    frames: [
      "    at computeBilling (app/services/verticals/hightech.js:37:29)",
      "    at provisionLicense (app/services/verticals/hightech.js:64:21)",
      '    at app/routes/verticals/hightech.js',
    ],
    impact: 'License provisioning is failing for new subscriptions.',
  },
  telco: {
    vertical: 'telco',
    page: 'telco.html',
    apiPath: '/api/telco/upgrade',
    owner: 'Riley Chen (subscriber-services-oncall)',
    brand: 'WaveConnect (Self-Service Portal)',
    service: 'acme-demo / telco vertical',
    endpoint: 'POST /api/telco/upgrade',
    errorType: 'TypeError',
    errorValue: "Cannot read properties of undefined (reading 'monthlyRate')",
    culprit: 'upgradePlan (app/services/verticals/telco.js:83)',
    frames: [
      "    at upgradePlan (app/services/verticals/telco.js:83:19)",
      '    at app/routes/verticals/telco.js',
    ],
    impact: 'Customers upgrading their plans are receiving 500 errors.',
  },
};

/**
 * Canned human-style bug reports for the Bug Triage Responder demo.
 * Deliberately fuzzy: they describe symptoms, not stack traces, so the
 * responder has to reproduce and dig.
 */
const BUG_REPORTS = {
  banking: 'Hey team — a customer on Premium is saying fund transfers keep failing in online banking. They just get a red "Transfer Failed" box every time, any amount, both accounts. Started seeing multiple support tickets about this today.',
  insurance: "Support escalation: policyholders can't file claims through the portal. The claim form spins and then errors out. One customer tried 4 times with different claim types — same result.",
  hightech: "Sales flagged that a prospect couldn't provision licenses during their trial — the provisioning step errors out on some plan selections. Might be plan-specific? Works on starter but they wanted enterprise seats.",
  telco: 'Getting complaints in the app store reviews that plan upgrades are broken — "tried to upgrade to Ultra and it just says something went wrong". Downgrade path untested.',
};

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
  return `run-${Math.random().toString(16).slice(2, 8)}`;
}

const DD_URL = () => process.env.DD_DASHBOARD_URL || 'https://app.datadoghq.com';

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

function contextBlock(service) {
  return {
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `Service: \`${service || 'checkout-api'}\` | ${new Date().toISOString()}` },
    ],
  };
}

/**
 * Build the plain-text alert card for a scenario.
 * When `unique` is true, a per-run reference is woven into the alert so the
 * responder treats it as a fresh occurrence; when false, the message matches
 * the canonical signature to demonstrate duplicate grouping.
 */
function buildAlertMessage(scenario, { runRef, now, firstSeen, events }) {

  const lines = [
    `:rotating_light: *Production Error — ${scenario.brand}*`,
    '',
    `*Error:* ${scenario.errorType}: ${scenario.errorValue}`,
    `*Location:* \`${scenario.culprit}\``,
    `*Endpoint:* ${scenario.endpoint}`,
    `*Service:* ${scenario.service}`,
    `*Owner:* ${scenario.owner} — demo persona, do not resolve to a real Slack user`,
    runRef ? `*Incident Ref:* ${runRef}` : null,
    '',
    `Level: error | Env: production | Release: acme-checkout@1.0.0`,
    `Events: ${events} | First: ${firstSeen.toISOString()} | Last: ${now.toISOString()}`,
    '',
    'Stack trace (top frames):',
    '```',
    `${scenario.errorType}: ${scenario.errorValue}`,
    ...scenario.frames,
    '```',
    `${scenario.impact} Repo: ${REPO_URL}`,
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
    return { ok: false, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  const runRef = options.unique !== false ? makeRunRef() : null;
  const now = new Date();
  const firstSeen = new Date(now.getTime() - (5 + Math.floor(Math.random() * 20)) * 60000);
  const events = 3 + Math.floor(Math.random() * 12);
  const text = buildAlertMessage(scenario, { runRef, now, firstSeen, events });
  const blocks = [
    headerBlock(`:rotating_light: Production Error — ${scenario.brand}`),
    ...fieldPairs([
      ['Error', `${scenario.errorType}: ${scenario.errorValue}`],
      ['Severity', 'error'],
      ['Location', `\`${scenario.culprit}\``],
      ['Endpoint', scenario.endpoint],
      ['Env', 'production'],
      ['Release', 'acme-checkout@1.0.0'],
      ['Events', `${events} | First: ${firstSeen.toISOString()}`],
      ['Owner', `${scenario.owner} — demo persona, do not resolve to a real Slack user`],
      runRef ? ['Incident Ref', runRef] : null,
    ]),
    mrkdwnSection(`*Stack trace (top frames):*\n\`\`\`${scenario.errorType}: ${scenario.errorValue}\n${scenario.frames.join('\n')}\`\`\``),
    mrkdwnSection(`${scenario.impact} Repo: ${REPO_URL}`),
    datadogActions(),
    contextBlock(scenario.service),
  ];
  const ts = await postMessage(token, alertsChannel, text, blocks);
  logger.info('On-Call alert posted', { scenario: scenarioId, channel: alertsChannel, ts });
  return { ok: true, ts, channel: alertsChannel };
}

/**
 * Post a human-style bug report to the On-Call bugs channel.
 * Accepts either a canned scenario id or free-form text.
 */
async function postOncallBugReport({ scenarioId, text, reporter, severity, productArea }) {
  const { token, bugsChannel } = resolveOncallEnv();
  if (!token || !bugsChannel) {
    logger.warn('On-Call bugs channel not configured — skipping bug report post');
    return { ok: false, error: 'SLACK_ONCALL_BUGS_CHANNEL_ID or bot token not configured' };
  }

  const body = text || BUG_REPORTS[scenarioId];
  if (!body) {
    return { ok: false, error: `No bug report text and unknown scenario: ${scenarioId}` };
  }

  let message = body;
  let blocks = null;
  if (reporter || severity || productArea) {
    const reportedBy = reporter && (reporter.name || reporter.email)
      ? [reporter.name, reporter.email && `<${reporter.email}>`].filter(Boolean).join(' ')
      : null;
    message = `:inbox_tray: New support ticket — Acme Support Center\n${body}`;
    blocks = [
      headerBlock(':inbox_tray: New support ticket — Acme Support Center'),
      ...fieldPairs([
        reportedBy ? ['Reported by', reportedBy] : null,
        productArea ? ['Product area', productArea] : null,
        severity ? ['Severity', severity] : null,
      ]),
      mrkdwnSection(body),
      contextBlock('acme-support-center'),
    ];
  }

  const ts = await postMessage(token, bugsChannel, message, blocks);
  logger.info('On-Call bug report posted', { scenario: scenarioId || 'custom', channel: bugsChannel, ts });
  return { ok: true, ts, channel: bugsChannel };
}

/**
 * Infra-style (SRE) incidents: each activates one of the app's built-in
 * incident scenarios (so the degradation is genuinely observable in latency,
 * logs, and error rates), posts a Datadog-monitor-style alert card to the
 * alerts channel, and auto-reverts to healthy after a window so the regular
 * demos are unaffected.
 */
const INFRA_WINDOW_MS = Number(
  process.env.ONCALL_INFRA_WINDOW_MS || process.env.ONCALL_LATENCY_WINDOW_MS || 10 * 60 * 1000,
);
let infraRevertTimer = null;

/**
 * Bounded, reversible memory-growth mode for the memory-leak incident.
 * Holds real allocated buffers so the process RSS genuinely climbs in
 * Datadog, but is strictly capped (ONCALL_MEMLEAK_CAP_MB, default 150MB)
 * well below the container limit and freed when the window ends.
 */
const MEMLEAK_CAP_MB = Math.min(Number(process.env.ONCALL_MEMLEAK_CAP_MB || 150), 300);
const MEMLEAK_CHUNK_MB = 8;
let memLeakChunks = [];
let memLeakInterval = null;

function startMemoryGrowth(windowMs) {
  stopMemoryGrowth();
  const steps = Math.max(1, Math.floor(MEMLEAK_CAP_MB / MEMLEAK_CHUNK_MB));
  const intervalMs = Math.max(2000, Math.floor(windowMs / (steps + 1)));
  memLeakInterval = setInterval(() => {
    if (memLeakChunks.length >= steps) return;
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
        title: ':warning: [Triggered] p95 latency spike — acme-demo storefront',
        monitor: '`avg(last_5m):p95:trace.express.request{service:checkout-api} > 2` — *Triggered*',
        fields: [
          ['Current p95', `${p95}s (baseline ${baseline}s)`],
          ['Affected endpoints', 'GET /search, POST /checkout'],
        ],
        symptoms: `Storefront pages loading slowly; app logs show repeated "Slow database query detected" warnings with 1500–3000ms query times. Error rate is normal — this is a latency degradation, not an outage. First: ${new Date(now.getTime() - 6 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the slow query path in the storefront search and checkout flows. Repo: ${REPO_URL}`,
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
          ['Blast radius', 'intermittent — most checkouts succeed, affected users see a spinner then a 502'],
        ],
        symptoms: `App logs show "PaymentGatewayTimeoutError" bursts; upstream payments-gateway p50 looks normal, suggesting a connection-handling or timeout-budget issue on our side rather than a provider outage. First: ${new Date(now.getTime() - 9 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the checkout payment-dependency path and its timeout handling. Repo: ${REPO_URL}`,
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
      const errPct = (13 + Math.random() * 4).toFixed(1);
      return {
        title: ':rotating_light: [SLO] Fast burn — checkout availability error budget',
        monitor: `\`burn_rate(slo:checkout-availability-99.9, window:1h) > 14.4\` — *Fast burn: ${burn}x*`,
        fields: [
          ['SLO', 'checkout availability 99.9% (30d) — monthly error budget exhausted in < 2 days at this rate'],
          ['Error rate', `${errPct}% of POST /checkout requests failing (InventoryReservationError)`],
        ],
        symptoms: `Intermittent checkout failures — inventory reservation errors on roughly 1 in 7 orders; retries succeed sometimes, which is why the raw error alert has not paged. Budget burn is what tripped this. First: ${new Date(now.getTime() - 32 * 60000).toISOString()} | Last: ${now.toISOString()}`,
        instruction: `Investigate the inventory reservation path in checkout. Repo: ${REPO_URL}`,
      };
    },
  },
};

async function postOncallInfraIncident(kind = 'latency') {
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

  if (incident.scenario !== 'healthy' || incident.memoryGrowth) {
    if (incident.scenario !== 'healthy') setScenario(incident.scenario);
    if (incident.memoryGrowth) startMemoryGrowth(INFRA_WINDOW_MS);
    if (infraRevertTimer) clearTimeout(infraRevertTimer);
    infraRevertTimer = setTimeout(() => {
      stopMemoryGrowth();
      if (incident.scenario !== 'healthy' && getScenario() === incident.scenario) {
        setScenario('healthy');
      }
      logger.info('On-Call infra incident window elapsed — reverted to healthy', { kind });
    }, INFRA_WINDOW_MS);
    if (infraRevertTimer.unref) infraRevertTimer.unref();
  }

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
    card.instruction,
  ].join('\n');
  const blocks = [
    headerBlock(card.title),
    mrkdwnSection(`*Monitor:* ${card.monitor}`),
    ...fieldPairs([
      ...card.fields,
      ['Env', 'production'],
      ['Service', '`checkout-api`'],
      ['Owner', ownerLine],
      ['Incident Ref', runRef],
    ]),
    mrkdwnSection(`*Symptoms:* ${card.symptoms}`),
    mrkdwnSection(card.instruction),
    datadogActions(),
    contextBlock('checkout-api'),
  ];

  const ts = await postMessage(token, alertsChannel, text, blocks);
  logger.info('On-Call infra incident posted', { kind, channel: alertsChannel, ts, runRef, windowMs: INFRA_WINDOW_MS });
  return { ok: true, ts, channel: alertsChannel, runRef, kind, scenario: incident.scenario, windowMinutes: Math.round(INFRA_WINDOW_MS / 60000) };
}

/**
 * Declare a SEV-1 incident in Datadog Incident Management.
 * With the Datadog Slack app installed and "Create Slack channels for
 * incidents" enabled, Datadog creates the incident-<n> channel itself and the
 * On-Call Incident Agent auto-joins it.
 */
async function declareDatadogIncident(runRef) {
  const apiKey = process.env.DD_API_KEY;
  const appKey = process.env.DD_APPLICATION_KEY;
  if (!apiKey || !appKey) {
    return null;
  }

  const site = process.env.DD_SITE || 'us5.datadoghq.com';
  const response = await axios.post(
    `https://api.${site}/api/v2/incidents`,
    {
      data: {
        type: 'incidents',
        attributes: {
          title: `SEV-1: acme-demo error rate spike across multiple verticals (${runRef})`,
          customer_impacted: true,
          fields: {
            severity: { type: 'dropdown', value: 'SEV-1' },
            summary: {
              type: 'textbox',
              value: `5xx rate > 40% for 5 minutes on checkout-api; banking, insurance, and telco endpoints affected. Incident Ref: ${runRef}. Repo: ${REPO_URL}`,
            },
          },
        },
      },
    },
    {
      headers: {
        'DD-API-KEY': apiKey,
        'DD-APPLICATION-KEY': appKey,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    },
  );

  const incident = response.data && response.data.data;
  return {
    id: incident && incident.id,
    publicId: incident && incident.attributes && incident.attributes.public_id,
  };
}

/**
 * Trigger a SEV-1 incident. Preferred path: declare a real Datadog incident
 * so Datadog's Slack integration creates the incident channel and the
 * Incident Agent auto-joins. Fallback (Datadog keys not configured): post a
 * SEV-1 style message to the alerts channel.
 */
async function postOncallIncident() {
  const runRef = makeRunRef();

  try {
    const incident = await declareDatadogIncident(runRef);
    if (incident) {
      logger.info('On-Call Datadog incident declared', { runRef, ...incident });
      return { ok: true, provider: 'datadog', runRef, ...incident };
    }
  } catch (error) {
    logger.error('Datadog incident declaration failed — falling back to Slack post', {
      error: error.message,
    });
  }

  const { token, alertsChannel } = resolveOncallEnv();
  if (!token || !alertsChannel) {
    logger.warn('On-Call alerts channel not configured — skipping incident post');
    return { ok: false, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  const text = [
    ':fire: *SEV-1 — acme-demo error rate spike across multiple verticals*',
    '',
    `*Incident Ref:* ${runRef}`,
    '*Signal:* 5xx rate > 40% for 5 minutes on checkout-api (banking, insurance, telco endpoints affected)',
    '*Env:* production | *Service:* checkout-api',
    '',
    `Multiple user-facing flows are failing simultaneously. Repo: ${REPO_URL}`,
  ].join('\n');

  const ts = await postMessage(token, alertsChannel, text);
  logger.info('On-Call incident posted', { channel: alertsChannel, ts, runRef });
  return { ok: true, ts, channel: alertsChannel, runRef };
}

module.exports = {
  ALERT_SCENARIOS,
  BUG_REPORTS,
  postOncallAlert,
  postOncallBugReport,
  INFRA_INCIDENTS,
  postOncallInfraIncident,
  postOncallIncident,
};
