const crypto = require('crypto');
const axios = require('axios');
const logger = require('../telemetry/logger');
const { postMessage, lookupSlackUserByEmail } = require('./slack');
const { getScenario, getOncallRunRef, setScopedScenario, clearScopedScenario } = require('../incidentModes');

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
const BUG_CATALOG = {
  banking: [
    {
      id: 'banking-transfer-failed',
      label: 'Fund transfers failing',
      sev: 'High',
      text: 'Hey team — a customer on Premium is saying fund transfers keep failing in online banking. They just get a red "Transfer Failed" box every time, any amount, both accounts. Started seeing multiple support tickets about this today.',
    },
    {
      id: 'banking-transfer-stuck',
      label: 'Money not moving between accounts',
      sev: 'Critical',
      text: "Escalating from the branch line: an elderly customer says she cannot move her pension payment from savings to checking — the website shows an error box every single time and she is worried the money is gone. I walked her through it twice on the phone and saw the same red failure message myself. Please treat as urgent.",
    },
  ],
  insurance: [
    {
      id: 'insurance-claim-error',
      label: 'Claim submissions erroring',
      sev: 'High',
      text: "Support escalation: policyholders can't file claims through the portal. The claim form spins and then errors out. One customer tried 4 times with different claim types — same result.",
    },
    {
      id: 'insurance-storm-claims',
      label: 'Storm-damage claims blocked',
      sev: 'Critical',
      text: 'We have a wave of storm-damage claims coming in after last night and NONE of them are going through the portal. Adjusters are telling customers to fax paperwork like it is 1995. Whatever broke the claim form, it picked the worst possible week.',
    },
  ],
  hightech: [
    {
      id: 'hightech-provision-error',
      label: 'License provisioning failing',
      sev: 'Medium',
      text: "Sales flagged that a prospect couldn't provision licenses during their trial — the provisioning step errors out on some plan selections. Might be plan-specific? Works on starter but they wanted enterprise seats.",
    },
    {
      id: 'hightech-renewal-blocked',
      label: 'Renewal seat expansion blocked',
      sev: 'High',
      text: 'Customer success here — our biggest renewal of the quarter is trying to add 200 seats and the admin console throws an error at the provisioning step every time. They renew Friday. The CSM has tried on three browsers, same failure.',
    },
  ],
  telco: [
    {
      id: 'telco-upgrade-broken',
      label: 'Plan upgrades broken',
      sev: 'Medium',
      text: 'Getting complaints in the app store reviews that plan upgrades are broken — "tried to upgrade to Ultra and it just says something went wrong". Downgrade path untested.',
    },
    {
      id: 'telco-family-plan',
      label: 'Family plan upgrade failing',
      sev: 'High',
      text: "My whole family is on the Plus plan and I've been trying to upgrade us to Ultra since yesterday. Every time I hit confirm it flashes an error and dumps me back to the plan page. My kids' data ran out and I literally cannot give you more money right now.",
    },
  ],
  retail: [
    {
      id: 'retail-slow-search',
      label: 'Search painfully slow',
      sev: 'Medium',
      infraKind: 'latency',
      text: "Is something wrong with the shop? Searching for anything takes like 3 seconds now — the little spinner just sits there. It was instant last week. No errors, just really, really slow. I timed it: typing 'espresso' took 2.8s to show results.",
    },
    {
      id: 'retail-checkout-hangs',
      label: 'Checkout hangs then errors',
      sev: 'High',
      infraKind: 'dependency-timeout',
      text: 'Trying to place an order and about every third attempt the payment step just hangs for ages and then shows a gateway error. If I retry immediately it usually goes through. Started within the last hour — my colleague sees the same thing from her account.',
    },
    {
      id: 'retail-orders-failing',
      label: 'Orders randomly failing',
      sev: 'High',
      infraKind: 'slo-burn',
      text: "Orders are failing at checkout roughly half the time — sometimes it says something about inventory, sometimes it's just a generic error. Retrying works eventually but customers are abandoning carts. Nothing changed on our side.",
    },
    {
      id: 'retail-site-sluggish',
      label: 'Site getting slower over time',
      sev: 'Medium',
      infraKind: 'memory-leak',
      text: "Not an outage, but checkout-api feels more sluggish the longer the day goes on — requests that were snappy this morning are noticeably laggy now. A refresh doesn't help. Feels like the server itself is running out of steam.",
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
function buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy }) {

  const lines = [
    `:rotating_light: *Production Error — ${scenario.brand}*`,
    '',
    `*Error:* ${scenario.errorType}: ${scenario.errorValue}`,
    `*Location:* \`${scenario.culprit}\``,
    `*Endpoint:* ${scenario.endpoint}`,
    `*Service:* ${scenario.service}`,
    `*Owner:* ${scenario.owner} — demo persona, do not resolve to a real Slack user`,
    runRef ? `*Incident Ref:* ${runRef}` : null,
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
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
  const triggeredBy = await resolveTriggeredBy(token, options.devinEmail);
  const now = new Date();
  const firstSeen = new Date(now.getTime() - (5 + Math.floor(Math.random() * 20)) * 60000);
  const events = 3 + Math.floor(Math.random() * 12);
  const text = buildAlertMessage(scenario, { runRef, now, firstSeen, events, triggeredBy });
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
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    mrkdwnSection(`*Stack trace (top frames):*\n\`\`\`${scenario.errorType}: ${scenario.errorValue}\n${scenario.frames.join('\n')}\`\`\``),
    mrkdwnSection(`${scenario.impact} Repo: ${REPO_URL}`),
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
  if (!token || !bugsChannel) {
    logger.warn('On-Call bugs channel not configured — skipping bug report post');
    return { ok: false, error: 'SLACK_ONCALL_BUGS_CHANNEL_ID or bot token not configured' };
  }

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
 * SEV-1 incident stories. Each maps to one of the infra degradations so the
 * declared incident is backed by a genuinely observable failure, and carries
 * the Datadog-facing title/summary used for the declared incident.
 */
const SEV1_INCIDENTS = {
  'checkout-gateway': {
    infraKind: 'dependency-timeout',
    label: 'Checkout degraded — payments-gateway timeouts',
    title: 'Checkout degraded — payments-gateway timeouts on checkout-api',
    summary: 'POST /checkout p99 above 5s; ~30% of checkout calls timing out against payments-gateway. Users see a spinner then a 504.',
  },
  'db-latency': {
    infraKind: 'latency',
    label: 'Site-wide slowness — DB query latency spike',
    title: 'Site-wide slowness — database query latency spike on checkout-api',
    summary: 'p95 latency 10x baseline on GET /search and POST /checkout; app logs show repeated slow-query warnings (1500-3000ms). No elevated error rate — pure latency degradation.',
  },
  'error-budget': {
    infraKind: 'slo-burn',
    label: 'Checkout availability — SLO fast burn',
    title: 'Checkout availability SLO fast burn — error budget exhausting on checkout-api',
    summary: 'Roughly half of POST /checkout requests failing (inventory reservation conflicts + tax-calculation errors). 30d error budget projected to exhaust in under 2 days at current burn rate.',
  },
  'memory-leak': {
    infraKind: 'memory-leak',
    label: 'Memory growth — checkout-api heading to OOM',
    title: 'Unbounded memory growth on checkout-api — OOM restart projected',
    summary: 'Process RSS climbing monotonically without plateau, consistent with an unbounded in-process cache. Latency creep expected as heap pressure grows; OOM restart projected if unaddressed.',
  },
};

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
  const kind = hasKind ? options.kind : 'checkout-gateway';
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
    activateInfraIncident(story.infraKind, SEV1_WINDOW_MS, runRef);
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

  // Fallback path (Datadog not configured): still activate the story's real
  // degradation so the page's "genuine live degradation" promise holds.
  supersedePriorRun(runRef);
  activateInfraIncident(story.infraKind, SEV1_WINDOW_MS, runRef);

  const text = [
    `:fire: *SEV-1 — ${story.label}*`,
    '',
    `*Incident Ref:* ${runRef}`,
    `*Summary:* ${story.summary}`,
    '*Env:* production | *Service:* checkout-api',
    `*Degradation window:* live now, auto-recovers in ~${Math.round(SEV1_WINDOW_MS / 60000)} minutes`,
    '',
    `The degradation is genuinely active and observable. Repo: ${REPO_URL}`,
  ].join('\n');
  const triggeredBy = await resolveTriggeredBy(token, options.devinEmail);
  const fullText = triggeredBy ? `${text}\nTriggered by: ${triggeredBy}` : text;

  let ts;
  try {
    ts = await postMessage(token, alertsChannel, fullText);
  } catch (error) {
    // Keep observable state consistent with what was announced: if the SEV-1
    // never posted, don't leave the app silently degraded for the full window.
    revertScopedInfra(runRef, 'SEV-1 fallback post failed');
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
  const resolveTimer = setTimeout(() => { entry.status = 'resolved'; }, SEV1_WINDOW_MS);
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
};
