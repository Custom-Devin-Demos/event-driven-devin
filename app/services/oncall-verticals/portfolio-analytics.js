const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { ownerRotation, postMessage, postThreadReply } = require('../slack');
const { createDevinSession, sendDevinSessionMessage } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

/**
 * Portfolio analytics API behind the portfolio manager workbench at
 * /oncall/c/79ab6e09 (holdings, exposures, drift versus model). Every
 * portfolio, security and figure here is synthetic.
 *
 * Self-contained on purpose: tuning this service never changes another skin.
 */
const ANALYTICS = {
  slug: '79ab6e09',
  service: 'portfolio-analytics-api',
  release: 'portfolio-analytics-api@2026.11.3',
  owner: 'Investment Analytics (analytics-oncall)',
  repo: 'COG-GTM/event-driven-devin',
  serviceFile: 'app/services/oncall-verticals/portfolio-analytics.js',
  page: 'app/public/verticals/79ab6e09.html',
  route: 'POST /api/oncall/79ab6e09/analytics/refresh',
};

const RISK_MODEL_CONFIG = {
  latencyBudgetMs: 2000,
  // Lowered during the risk model vendor's capacity incident (RM-4417).
  // RM-4417 is closed and the vendor now serves 16 concurrent reads per client.
  factorReadConcurrency: 1,
  vendorMaxConcurrency: 16,
};

const LATENCY = { positionsMs: 120, pricesMs: 150, aggregateMs: 150 };
const ALERT_COOLDOWN_MS = Number(process.env.PORTFOLIO_ANALYTICS_ALERT_COOLDOWN_MS) > 0
  ? Number(process.env.PORTFOLIO_ANALYTICS_ALERT_COOLDOWN_MS)
  : 10 * 60 * 1000;

const PORTFOLIO = {
  id: 'GEQ-MODEL-07',
  name: 'Global Equity Growth Sleeve 07',
  model: 'Global Equity Growth Model',
  benchmark: 'Synthetic World Equity Index',
  currency: 'USD',
  navMinor: 482650000000,
  asOf: '2026-11-24',
};

const SECTORS = ['Information Technology', 'Health Care', 'Financials', 'Industrials', 'Consumer Discretionary', 'Energy'];
const REGIONS = ['North America', 'Europe', 'Asia Pacific', 'Emerging Markets'];
const FACTORS = ['Value', 'Momentum', 'Quality', 'Size', 'Volatility'];
const NAMES = [
  'Northfield Semiconductor', 'Halden Cloud Systems', 'Arcturus Software', 'Verity Networks', 'Solace Devices', 'Kinsale Data',
  'Meridian Biologics', 'Aldercrest Pharma', 'Lumen Diagnostics', 'Tarn Medical', 'Corvale Therapeutics', 'Oakhaven Health',
  'Castellan Bancorp', 'Pinecrest Insurance', 'Harrowgate Exchange', 'Vantor Payments', 'Lindqvist Asset Servicing', 'Sable Reinsurance',
  'Ironbridge Machinery', 'Calder Aerospace', 'Fenwick Rail', 'Stratum Automation', 'Briarwood Logistics', 'Tessel Electric',
  'Marlowe Retail', 'Avenir Motors', 'Kittiwake Leisure', 'Dunmore Apparel', 'Solstice Travel', 'Larkfield Home',
  'Petrel Energy', 'Caldera Gas', 'Borealis Renewables', 'Highmoor Pipelines', 'Tidewater Refining', 'Zephyr Wind',
];

function holdings() {
  const raw = NAMES.map((name, i) => {
    const weightBps = 420 - ((i * 53) % 230);
    const driftBps = ((i * 37) % 61) - 30;
    return {
      id: `SYN-${String(1001 + i)}`,
      ticker: `${name.replace(/[^A-Z]/gi, '').slice(0, 3).toUpperCase()}${String.fromCharCode(65 + (i % 26))}`,
      name,
      sector: SECTORS[Math.floor(i / 6)],
      region: REGIONS[(i * 7) % REGIONS.length],
      weightBps,
      modelWeightBps: weightBps - driftBps,
      factorReadMs: 205 + ((i * 29) % 51),
    };
  });
  const total = raw.reduce((sum, h) => sum + h.weightBps, 0);
  const modelTotal = raw.reduce((sum, h) => sum + h.modelWeightBps, 0);
  return raw.map((h) => {
    const weightPct = Math.round((h.weightBps / total) * 10000) / 100;
    const modelPct = Math.round((h.modelWeightBps / modelTotal) * 10000) / 100;
    return {
      id: h.id, ticker: h.ticker, name: h.name, sector: h.sector, region: h.region,
      weightPct, modelPct, driftPct: Math.round((weightPct - modelPct) * 100) / 100,
      marketValueMinor: Math.round((PORTFOLIO.navMinor * weightPct) / 100),
      factorReadMs: h.factorReadMs,
    };
  });
}

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
let activeIncident = null;

function makeTrace() {
  const spans = new Map();
  return {
    async span(name, fn) {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        const current = spans.get(name) || { name, count: 0, totalMs: 0 };
        current.count += 1;
        current.totalMs += Date.now() - start;
        spans.set(name, current);
      }
    },
    spans: () => Array.from(spans.values()),
  };
}

/** Risk model read of one holding's factor loadings. */
function factorLoadings(holding, index) {
  return FACTORS.reduce((acc, factor, f) => {
    acc[factor] = Math.round((((index * 17 + f * 31) % 41) - 20) * 5) / 100;
    return acc;
  }, {});
}

async function readFactorExposures(positions, trace, sleep) {
  const concurrency = RISK_MODEL_CONFIG.factorReadConcurrency;
  const loaded = [];
  for (let i = 0; i < positions.length; i += concurrency) {
    const batch = positions.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((holding, j) => trace.span('analytics.risk_model_factor_read', async () => {
      await sleep(holding.factorReadMs);
      return { id: holding.id, weightPct: holding.weightPct, loadings: factorLoadings(holding, i + j) };
    })));
    loaded.push(...results);
  }
  return loaded;
}

function groupBy(positions, key) {
  const groups = new Map();
  positions.forEach((h) => {
    const g = groups.get(h[key]) || { name: h[key], weightPct: 0, modelPct: 0 };
    g.weightPct += h.weightPct;
    g.modelPct += h.modelPct;
    groups.set(h[key], g);
  });
  return Array.from(groups.values()).map((g) => ({
    name: g.name,
    weightPct: Math.round(g.weightPct * 100) / 100,
    modelPct: Math.round(g.modelPct * 100) / 100,
    activePct: Math.round((g.weightPct - g.modelPct) * 100) / 100,
  }));
}

function publicHolding(h) {
  const { factorReadMs, ...rest } = h;
  return rest;
}

/** Last published snapshot: holdings and weights only, no risk model call. */
function getSnapshot() {
  const positions = holdings();
  return {
    portfolio: PORTFOLIO,
    budgetMs: RISK_MODEL_CONFIG.latencyBudgetMs,
    holdings: positions.map(publicHolding),
    sectors: groupBy(positions, 'sector'),
    regions: groupBy(positions, 'region'),
    trackingErrorPct: 2.37,
    activeSharePct: 61.4,
  };
}

/** Run analytics: positions, prices, factor exposures and drift versus model. */
async function refreshAnalytics({ sleep = realSleep, now = Date.now } = {}) {
  const trace = makeTrace();
  const startedAt = now();
  const positions = await trace.span('analytics.load_positions', async () => {
    await sleep(LATENCY.positionsMs);
    return holdings();
  });
  await trace.span('analytics.price_snapshot', () => sleep(LATENCY.pricesMs));
  const loaded = await readFactorExposures(positions, trace, sleep);
  const factors = await trace.span('analytics.aggregate', async () => {
    await sleep(LATENCY.aggregateMs);
    return FACTORS.map((factor) => ({
      name: factor,
      exposure: Math.round(loaded.reduce((sum, h) => sum + (h.weightPct / 100) * h.loadings[factor], 0) * 1000) / 1000,
    }));
  });
  const durationMs = Math.max(1, now() - startedAt);
  const overBudget = durationMs > RISK_MODEL_CONFIG.latencyBudgetMs;
  recordTiming('portfolio_analytics.refresh.latency', durationMs, { service: ANALYTICS.service });
  logger[overBudget ? 'warn' : 'info']('Portfolio analytics refresh completed', {
    service: ANALYTICS.service, portfolioId: PORTFOLIO.id, durationMs, budgetMs: RISK_MODEL_CONFIG.latencyBudgetMs, holdings: positions.length,
  });
  return {
    ...getSnapshot(),
    ok: true,
    overBudget,
    durationMs,
    factorReads: loaded.length,
    factorReadConcurrency: RISK_MODEL_CONFIG.factorReadConcurrency,
    factors,
    spans: trace.spans(),
  };
}

/** Repo link on the alert card: ONCALL_REPO_URL (may name a branch) when set. */
function repoUrl() {
  return process.env.ONCALL_REPO_URL || `https://github.com/${ANALYTICS.repo}`;
}

function alertTitle() {
  return `p95 latency: Run analytics, ${ANALYTICS.service} (portfolio manager workbench)`;
}

function seconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildAlertMessage(result, { reference, now }) {
  return [
    `:rotating_light: *[Triggered] ${alertTitle()}*`,
    '',
    `*Service:* ${ANALYTICS.service}`,
    '*Where:* Portfolio analytics, Run analytics',
    `*Endpoint:* ${ANALYTICS.route}`,
    `*Metric value:* ${seconds(result.durationMs)} | *Threshold:* > ${seconds(RISK_MODEL_CONFIG.latencyBudgetMs)} | *Baseline:* ~900ms (7-day p95)`,
    `*Portfolio:* ${PORTFOLIO.id} (${result.holdings.length} holdings, synthetic)`,
    `*Release:* ${ANALYTICS.release}`,
    `*Owner:* ${ownerRotation(ANALYTICS.owner)}`,
    `*Incident Ref:* ${reference}`,
    '*Impact:* holdings, exposures and drift versus model take about 9 seconds to refresh for every portfolio manager. Figures are correct once they arrive; error rate is normal.',
    '',
    `Reported: ${now.toISOString()}`,
    `Repo: ${repoUrl()}`,
  ].join('\n');
}

function buildAlertBlocks(result, ctx) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${alertTitle()}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: buildAlertMessage(result, ctx).split('\n').slice(2).join('\n') } },
  ];
}

/** Branch the fix PR targets: the branch in ONCALL_REPO_URL (…/tree/<branch>) when set, else main. */
function baseBranch() {
  const match = /\/tree\/([\w./-]+)$/.exec(process.env.ONCALL_REPO_URL || '');
  return match ? match[1] : 'main';
}

function buildSessionPrompt(result, { reference, channel, threadTs }) {
  const base = baseBranch();
  const spanLines = result.spans
    .map((span) => `  - ${span.name}: ${span.count} call(s), ${span.totalMs} ms total`)
    .join('\n');
  const prompt = `Portfolio managers report that Run analytics on the portfolio analytics workbench (holdings, exposures, drift versus model) takes about 9 seconds. The figures are correct once they arrive and nothing errors. All data in this service is synthetic.

*Alert:* ${alertTitle()}, Triggered
*Incident Ref:* ${reference}
*Observed:* ${ANALYTICS.route} returned HTTP 200 after ${result.durationMs} ms (latency budget ${RISK_MODEL_CONFIG.latencyBudgetMs} ms); release ${ANALYTICS.release}
*Server spans for this request:*
${spanLines}

Repository: https://github.com/${ANALYTICS.repo}, branch ${base}. The service is ${ANALYTICS.serviceFile}, its route is in app/routes/oncall.js, the page is ${ANALYTICS.page}, tests are in tests/.

Steps:
1. Diagnose from the code and the spans above where the time goes. State it as evidence, not guesses.
2. Reproduce locally on branch ${base} with alerts off: start the server with no Slack or Devin credentials (env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3100 DD_TRACE_ENABLED=false node app/server.js) and time the request (curl -s -o /dev/null -w '%{time_total}\\n' -X POST localhost:3100/api/oncall/${ANALYTICS.slug}/analytics/refresh). Never open or submit the page on devindemos.com.
3. Fix it in ${ANALYTICS.serviceFile} only. Every holding's factor exposures must still be read exactly once, results must be unchanged, and the risk model vendor's limit must never be exceeded. Add a jest regression test (tests/${ANALYTICS.slug}-portfolio-analytics*.test.js) that fails before the fix and passes after it; run it with the existing ${ANALYTICS.slug} tests.
4. Open a PR against branch ${base} titled "Portfolio analytics: bring Run analytics back under the latency budget (${reference})" with the root cause, the before and after timings and the test output. Do NOT merge and do NOT deploy: the demo is re-run from the unfixed branch.
5. Reply ONCE in the Slack alert thread with the root cause in one line, the before and after timings and the PR link. No em dashes in the reply or the PR.
`;
  if (channel && threadTs) return `${prompt}\n*Slack Thread:* channel=${channel} thread_ts=${threadTs}`;
  return prompt;
}

function resolveSessionIdentity() {
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
    apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
  };
}

// The demo's OnCall Bot. PORTFOLIO_ANALYTICS_ONCALL_BOT_ID / DEVIN_ONCALL_BOT_ID
// override it. `channel` posts the alert card only and leaves the investigation
// to the alerts channel's responder; any other non-bot value (e.g. `off`)
// starts a plain Devin session instead of paging a Bot.
const DEFAULT_ONCALL_BOT_ID = 'bot-e6009d3547b7409da6ab72c02a823939';

function responderMode() {
  const configured = (process.env.PORTFOLIO_ANALYTICS_ONCALL_BOT_ID || process.env.DEVIN_ONCALL_BOT_ID || '').trim();
  if (configured === 'channel') return { mode: 'channel', botId: null };
  const id = configured || DEFAULT_ONCALL_BOT_ID;
  return /^bot-[0-9a-f]{32}$/.test(id) ? { mode: 'bot', botId: id } : { mode: 'session', botId: null };
}

function sessionTitle(reference) {
  return `[On-Call] ${reference} Portfolio analytics: Run analytics over latency budget`;
}

function buildBotPage(result, ctx) {
  return `:rotating_light: On-call page: ${alertTitle()} (${ctx.reference})

You are the OnCall Bot and this incident is yours. Respond to it the way you respond to every on-call page:
- Dispatch ONE child session on Linux with repo ${ANALYTICS.repo}, titled "${sessionTitle(ctx.reference)}", whose prompt is the runbook below verbatim.
- Track it to the end: when the session reports, check the PR exists, targets branch ${baseBranch()}, and carries the before and after timings and the regression test output; send it back if anything is missing.
- Bring the result to your owner in one Inbox item on the PR (review only: merging needs their approval, and the branch keeps the defect for the demo).
- If the same incident pages you again, it joins this response; do not dispatch a second session.

----- RUNBOOK -----
${buildSessionPrompt(result, ctx)}`;
}

async function runIncident(incident, result, ctx) {
  const token = process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID;
  let threadTs = null;
  if (!token || !channel) {
    logger.warn('On-Call alerts channel not configured: portfolio analytics alert not posted', { reference: incident.reference });
  } else {
    try {
      threadTs = await postMessage(token, channel, buildAlertMessage(result, ctx), buildAlertBlocks(result, ctx));
      incident.alert = { channel, ts: threadTs };
    } catch (error) {
      logger.error('Portfolio analytics On-Call alert failed', { reference: incident.reference, error: error.message });
    }
  }

  const { mode, botId } = responderMode();
  if (mode === 'channel') return incident;
  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('Portfolio analytics Devin session creation throttled', { reference: incident.reference, ...cap });
    return incident;
  }
  const release = reserveSession();
  const promptCtx = { ...ctx, channel, threadTs };
  try {
    let responder = null;
    if (botId) {
      const paged = await sendDevinSessionMessage(botId, buildBotPage(result, promptCtx), resolveSessionIdentity());
      if (paged) {
        responder = { id: botId, url: paged.url || process.env.PORTFOLIO_ANALYTICS_ONCALL_BOT_URL || null };
        incident.bot = responder;
      } else {
        logger.warn('OnCall Bot page failed: starting a plain Devin session instead', { reference: incident.reference, botId });
      }
    }
    if (!responder) {
      const session = await createDevinSession(buildSessionPrompt(result, promptCtx), {
        ...resolveSessionIdentity(), title: sessionTitle(ctx.reference), platform: 'linux', repos: [ANALYTICS.repo],
      });
      if (session) {
        responder = { id: session.sessionId, url: session.url };
        incident.session = responder;
      }
    }
    if (!responder) {
      release();
      return incident;
    }
    if (token && channel && threadTs) {
      const text = incident.bot
        ? `:robot_face: *OnCall Bot is responding to this alert*${responder.url ? `: <${responder.url}|View OnCall Bot>` : ''} (dispatches a Devin session to investigate and open the fix PR)`
        : `:mag: *Devin is investigating this alert*: <${responder.url}|View session>`;
      await postThreadReply(token, channel, threadTs, incident.bot ? 'OnCall Bot is responding' : `Devin is investigating: ${responder.url}`, [{
        type: 'section',
        text: { type: 'mrkdwn', text },
      }]).catch((error) => logger.error('Portfolio analytics responder link reply failed', { error: error.message }));
    }
  } catch (error) {
    release();
    logger.error('Portfolio analytics incident responder failed', { reference: incident.reference, error: error.message });
  }
  return incident;
}

/**
 * Records an over-budget refresh and, at most once per cooldown window, posts
 * one alert and pages one responder. Further slow refreshes during the window
 * join the open incident.
 */
function raiseIncident(result, { nowMs = Date.now() } = {}) {
  if (activeIncident && nowMs - activeIncident.openedAt < ALERT_COOLDOWN_MS) {
    activeIncident.occurrences += 1;
    return { incident: activeIncident, created: false, outcome: Promise.resolve(activeIncident) };
  }
  const reference = `PA-${crypto.randomBytes(3).toString('hex')}`;
  activeIncident = { reference, openedAt: nowMs, occurrences: 1, alert: null, session: null, bot: null };
  const ctx = { reference, now: new Date(nowMs) };
  incrementMetric('portfolio_analytics.refresh.over_budget', { service: ANALYTICS.service });
  Sentry.captureMessage(alertTitle(), {
    level: 'warning',
    tags: { service: ANALYTICS.service, slug: ANALYTICS.slug },
    extra: { reference, durationMs: result.durationMs, budgetMs: RISK_MODEL_CONFIG.latencyBudgetMs },
  });
  const outcome = runIncident(activeIncident, result, ctx);
  return { incident: activeIncident, created: true, outcome };
}

function resetIncidentsForTests() {
  activeIncident = null;
}

module.exports = {
  ANALYTICS,
  DEFAULT_ONCALL_BOT_ID,
  RISK_MODEL_CONFIG,
  PORTFOLIO,
  holdings,
  getSnapshot,
  refreshAnalytics,
  responderMode,
  buildAlertMessage,
  buildSessionPrompt,
  buildBotPage,
  raiseIncident,
  resetIncidentsForTests,
};
