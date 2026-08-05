const logger = require('../telemetry/logger');
const { postMessage } = require('./slack');

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

/**
 * Build the plain-text alert card for a scenario.
 * When `unique` is true, a per-run reference is woven into the alert so the
 * responder treats it as a fresh occurrence; when false, the message matches
 * the canonical signature to demonstrate duplicate grouping.
 */
function buildAlertMessage(scenario, { unique = true } = {}) {
  const runRef = unique ? makeRunRef() : null;
  const now = new Date();
  const firstSeen = new Date(now.getTime() - (5 + Math.floor(Math.random() * 20)) * 60000);
  const events = 3 + Math.floor(Math.random() * 12);

  const lines = [
    `:rotating_light: *Production Error — ${scenario.brand}*`,
    '',
    `*Error:* ${scenario.errorType}: ${scenario.errorValue}`,
    `*Location:* \`${scenario.culprit}\``,
    `*Endpoint:* ${scenario.endpoint}`,
    `*Service:* ${scenario.service}`,
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

  const text = buildAlertMessage(scenario, options);
  const ts = await postMessage(token, alertsChannel, text);
  logger.info('On-Call alert posted', { scenario: scenarioId, channel: alertsChannel, ts });
  return { ok: true, ts, channel: alertsChannel };
}

/**
 * Post a human-style bug report to the On-Call bugs channel.
 * Accepts either a canned scenario id or free-form text.
 */
async function postOncallBugReport({ scenarioId, text }) {
  const { token, bugsChannel } = resolveOncallEnv();
  if (!token || !bugsChannel) {
    logger.warn('On-Call bugs channel not configured — skipping bug report post');
    return { ok: false, error: 'SLACK_ONCALL_BUGS_CHANNEL_ID or bot token not configured' };
  }

  const message = text || BUG_REPORTS[scenarioId];
  if (!message) {
    return { ok: false, error: `No bug report text and unknown scenario: ${scenarioId}` };
  }

  const ts = await postMessage(token, bugsChannel, message);
  logger.info('On-Call bug report posted', { scenario: scenarioId || 'custom', channel: bugsChannel, ts });
  return { ok: true, ts, channel: bugsChannel };
}

/**
 * Post a SEV-1 style incident burst to the alerts channel.
 * Placeholder for the full Datadog Incident Management flow: once the
 * Datadog monitor + incident channel automation is wired up, this will
 * instead push metrics that trip the monitor.
 */
async function postOncallIncident() {
  const { token, alertsChannel } = resolveOncallEnv();
  if (!token || !alertsChannel) {
    logger.warn('On-Call alerts channel not configured — skipping incident post');
    return { ok: false, error: 'SLACK_ONCALL_ALERTS_CHANNEL_ID or bot token not configured' };
  }

  const runRef = makeRunRef();
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
  postOncallIncident,
};
