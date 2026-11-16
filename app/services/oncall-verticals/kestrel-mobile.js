const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');
const { incrementMetric } = require('../../telemetry/datadog');
const { ownerRotation, postMessage, postThreadReply } = require('../slack');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

/**
 * Kestrel Bank mobile payments API (fictional bank) — the shared backend the
 * native Kestrel iOS and Android apps call from "Make a payment".
 *
 * Kept separate from the shared banking vertical on purpose: tuning this
 * service never changes NatWest or the other banking skins.
 */
const KESTREL = {
  slug: '2e790636',
  service: 'kestrel-payments-api',
  release: 'kestrel-payments-api@2026.11.2',
  owner: 'Kestrel Payments (payments-oncall)',
  repos: ['COG-GTM/event-driven-devin', 'COG-GTM/ios-demos', 'COG-GTM/android-demos'],
  serviceFile: 'app/services/oncall-verticals/kestrel-mobile.js',
  appDir: 'apps/2e790636',
  platforms: { ios: 'iOS', android: 'Android' },
};

const PAYMENT_CONFIG = {
  authHoldTtlMs: 5000,
  amlWindowDays: 90,
  // Temporary cap from the screening partner's rate-limit incident (VO-8821).
  // VO-8821 is closed and the partner now allows 32 concurrent calls.
  screeningConcurrency: 1,
  screeningPartnerMaxConcurrency: 32,
  sloMs: 1500,
};

const LATENCY = { authorizeHoldMs: 120, amlWindowMs: 150, submitMs: 150 };
const ACCOUNT = { number: '41827365', sortCode: '40-27-19', balanceMinor: 218462 };
const PAYEES = { 'priya-shah': { name: 'Priya Shah', sortCode: '20-45-77', account: '63391028' } };
const CALM_ERROR = "We couldn't make this payment right now. Nothing has left your account. Please try again in a few minutes.";
const ALERT_COOLDOWN_MS = Number(process.env.KESTREL_ALERT_COOLDOWN_MS) > 0
  ? Number(process.env.KESTREL_ALERT_COOLDOWN_MS)
  : 10 * 60 * 1000;

const realSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
let activeIncident = null;

function amlWindow() {
  return Array.from({ length: 36 }, (_, i) => ({
    id: `KB-TX-${String(1000 + i)}`,
    daysAgo: Math.floor((i * PAYMENT_CONFIG.amlWindowDays) / 36),
    screeningMs: 180 + ((i * 37) % 141),
  }));
}

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

async function screenAll(transactions, trace, sleep) {
  const concurrency = PAYMENT_CONFIG.screeningConcurrency;
  const screened = [];
  for (let i = 0; i < transactions.length; i += concurrency) {
    const batch = transactions.slice(i, i + concurrency);
    const results = await Promise.all(batch.map((txn) => trace.span('payments.aml_screen', async () => {
      await sleep(txn.screeningMs);
      return { id: txn.id, clear: true };
    })));
    screened.push(...results);
  }
  return screened;
}

function validatePayment(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const payee = Object.hasOwn(PAYEES, body.payeeId) ? PAYEES[body.payeeId] : null;
  if (body.fromAccount !== ACCOUNT.number || !payee) return null;
  if (!Number.isInteger(body.amountMinor) || body.amountMinor < 1 || body.amountMinor > 100000) return null;
  if (body.currency !== 'GBP') return null;
  const reference = typeof body.reference === 'string'
    ? body.reference.replace(/[^\w .-]/g, '').trim().slice(0, 18)
    : '';
  return { fromAccount: ACCOUNT.number, payeeId: body.payeeId, payee, amountMinor: body.amountMinor, reference };
}

async function makePayment(payment, { sleep = realSleep, now = Date.now } = {}) {
  const trace = makeTrace();
  const startedAt = now();
  const hold = await trace.span('payments.authorize_hold', async () => {
    await sleep(LATENCY.authorizeHoldMs);
    return { id: `KB-HOLD-${crypto.randomBytes(2).toString('hex')}`, expiresAt: now() + PAYMENT_CONFIG.authHoldTtlMs };
  });
  const transactions = await trace.span('payments.aml_window', async () => {
    await sleep(LATENCY.amlWindowMs);
    return amlWindow();
  });
  const screened = await screenAll(transactions, trace, sleep);
  const submitted = await trace.span('payments.submit', async () => {
    await sleep(LATENCY.submitMs);
    return now() <= hold.expiresAt;
  });
  const durationMs = Math.max(1, now() - startedAt);
  const base = {
    durationMs,
    screeningCount: screened.length,
    screeningConcurrency: PAYMENT_CONFIG.screeningConcurrency,
    spans: trace.spans(),
  };
  if (!submitted) return { ...base, ok: false, error: 'HOLD_EXPIRED' };
  return {
    ...base,
    ok: true,
    confirmationId: `KB-PAY-${crypto.randomBytes(2).toString('hex')}`,
    balanceMinor: ACCOUNT.balanceMinor - payment.amountMinor,
  };
}

function platformOf(value) {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.prototype.hasOwnProperty.call(KESTREL.platforms, key) ? key : 'unknown';
}

function clientRelease(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,63}$/.test(value) ? value : 'kestrel-mobile@unknown';
}

function screenSpan(result) {
  return result.spans.find((span) => span.name === 'payments.aml_screen') || { count: 0, totalMs: 0 };
}

function alertTitle() {
  return `Make a payment failing — ${KESTREL.service} (Kestrel Bank iOS + Android)`;
}

function buildAlertMessage(result, { reference, platform, release, now }) {
  return [
    `:rotating_light: *[Triggered] ${alertTitle()}*`,
    '',
    `*Service:* ${KESTREL.service} — shared payments API behind the Kestrel Bank iOS and Android apps`,
    '*Where:* Make a payment → Make payment',
    `*Error:* HTTP 504 HOLD_EXPIRED after ${result.durationMs.toLocaleString('en-US')} ms (SLO ${PAYMENT_CONFIG.sloMs} ms)`,
    '*Affected clients:* iOS and Android (both apps call this API)',
    `*First report:* ${KESTREL.platforms[platform] || 'unknown client'} · ${release}`,
    `*Release:* ${KESTREL.release}`,
    `*Owner:* ${ownerRotation(KESTREL.owner)}`,
    `*Incident Ref:* ${reference}`,
    '*Customer impact:* payment spins ~9 s then fails calmly; nothing leaves the account',
    '',
    `Reported: ${now.toISOString()}`,
    `Repo: https://github.com/${KESTREL.repos[0]} (${KESTREL.serviceFile})`,
    `Repo: https://github.com/${KESTREL.repos[1]} (${KESTREL.appDir})`,
    `Repo: https://github.com/${KESTREL.repos[2]} (${KESTREL.appDir})`,
  ].join('\n');
}

function buildAlertBlocks(result, ctx) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${alertTitle()}`, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: buildAlertMessage(result, ctx).split('\n').slice(2).join('\n') } },
  ];
}

function buildSessionPrompt(result, { reference, platform, release, channel, threadTs }) {
  const screen = screenSpan(result);
  const spanLines = result.spans
    .map((span) => `  - ${span.name}: ${span.count} call(s), ${span.totalMs} ms total`)
    .join('\n');
  const prompt = `Kestrel Bank (a fictional bank used for public demos) customers cannot make payments from the native mobile apps. Both the iOS and Android apps call the same backend, ${KESTREL.service}, and both fail the same way: the Make payment button spins for ~9 s, then the app shows "${CALM_ERROR}" No money moves.

*Alert:* ${alertTitle()} — Triggered
*Incident Ref:* ${reference}
*Observed:* POST /api/oncall/${KESTREL.slug}/mobile/payments → HTTP 504 HOLD_EXPIRED after ${result.durationMs} ms (SLO ${PAYMENT_CONFIG.sloMs} ms); first reported from the ${KESTREL.platforms[platform] || 'unknown'} app (${release}); release ${KESTREL.release}
*Server spans for this payment:*
${spanLines}
  (screening: ${screen.count} transactions, concurrency ${result.screeningConcurrency})

Repositories:
- Backend (the shared defect): https://github.com/${KESTREL.repos[0]} — ${KESTREL.serviceFile}, route in app/routes/oncall.js, tests in tests/
- iOS client: https://github.com/${KESTREL.repos[1]} — ${KESTREL.appDir} (read its DEMO.md)
- Android client: https://github.com/${KESTREL.repos[2]} — ${KESTREL.appDir} (read its DEMO.md)

You are the LEAD for this incident, on Linux. Steps:
1. Diagnose: confirm from the code and the spans above where the ~9 s goes and why the payment fails (compare against the authorization hold TTL). State it as evidence, not guesses. Confirm the iOS and Android clients are thin clients of this API (no client fix needed) by reading their payment code read-only.
2. Fix the backend in ${KESTREL.repos[0]} only, in ${KESTREL.serviceFile}. Keep the 5 s authorization hold, keep the 90-day AML window, screen every transaction exactly once, never exceed the partner ceiling (screeningPartnerMaxConcurrency). Add a jest regression test (tests/2e790636-kestrel-mobile-payments*.test.js) that fails on main and passes on the fix; run it and the existing Kestrel tests. Open a PR titled "Kestrel Bank: fix mobile Make a payment 504s (iOS + Android)". Do NOT merge — main keeps the bug so the demo can be re-run.
3. Create TWO testing child Devin sessions in parallel, each given the diagnosis, PR branch and the instructions in step 4:
   - a *macOS* child: repos ${KESTREL.repos[1]} + ${KESTREL.repos[0]}, iOS Simulator, app ${KESTREL.appDir} (use @skills:ios-demos-simulator-testing if available)
   - a *Linux* child: repos ${KESTREL.repos[2]} + ${KESTREL.repos[0]}, Android emulator, app ${KESTREL.appDir} (use @skills:android-demos-runtime-testing)
   Title them "Kestrel iOS testing — ${reference}" and "Kestrel Android testing — ${reference}", and ask to be notified when each finishes.
4. Each testing child must: run ${KESTREL.repos[0]} locally TWICE with no Slack/Devin credentials — main on port 3100 and the fix branch on port 3101 — and launch the app with the payments base URL override from its DEMO.md (\`make run\`, demo alerts OFF; never \`make demo\`, never devindemos.com). Get the simulator/emulator window large and centred on the desktop, app on its Home screen, BEFORE starting each recording. Then make THREE SEPARATE recordings with Devin's built-in screen recorder (recording_start → annotate_recording → recording_stop), real taps on the real app, real time (no speed-up, no ffmpeg editing):
   - Recording "<iOS|Android> BEFORE — backend main": annotate setup "Backend main on :3100 (planted defect), alerts off"; test_start "It should make a £25 payment to Priya Shah on backend main"; tap Home → Make a payment → Make payment; when the calm error appears, assertion test_result=failed: "HTTP 504 HOLD_EXPIRED after <measured> s (SLO 1.5 s); calm error shown; balance unchanged £2,184.62".
   - Recording "<iOS|Android> AFTER — fix branch": setup "Backend fix branch on :3101, alerts off"; test_start "It should make a £25 payment in under 1.5 s on the fix branch"; same taps; assertion passed: "HTTP 200 in <measured> s; Payment sent receipt; balance £2,159.62".
   - Recording "<iOS|Android> REGRESSION — fix branch": test_start "It should complete 3 back-to-back payments under 1.5 s"; three payments, one assertion per payment with its measured time; then test_start "It should pass the backend regression test" with one assertion stating the jest result (FAIL on main, PASS on fix).
   Use the server's request log for every measured time. Each recording_stop needs a short title and a summary that leads with PASS/FAIL. Keep each recording under 2 minutes, with no long idle setup inside it. Send all three recordings as attachments in the final message (not MP4s you made yourself), with the measured times in a 3-row table. Do not open PRs in the app repos.
5. When both children finish, open each child's recordings (devin_session_interact get_attachments), confirm all six exist, play, and show the right result; send a child back to re-record if one is missing or wrong. Then:
   - post ONE comment on your PR with a table: rows BEFORE / AFTER / REGRESSION, columns iOS / Android, each cell the measured time + PASS/FAIL and the recording, plus links to both testing sessions;
   - reply ONCE in the Slack alert thread with: Root cause (1 line), PR link, the two testing session links;
   - end with a short final message: root cause in one sentence, the fix in one sentence, the PR link, the 2×3 results table, and the two testing session links.
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

async function runIncident(incident, result, ctx) {
  const token = process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID;
  let threadTs = null;
  if (!token || !channel) {
    logger.warn('On-Call alerts channel not configured — Kestrel alert not posted', { reference: incident.reference });
  } else {
    try {
      threadTs = await postMessage(token, channel, buildAlertMessage(result, ctx), buildAlertBlocks(result, ctx));
      incident.alert = { channel, ts: threadTs };
    } catch (error) {
      logger.error('Kestrel On-Call alert failed', { reference: incident.reference, error: error.message });
    }
  }

  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('Kestrel Devin session creation throttled', { reference: incident.reference, ...cap });
    return incident;
  }
  const release = reserveSession();
  try {
    const session = await createDevinSession(buildSessionPrompt(result, { ...ctx, channel, threadTs }), {
      ...resolveSessionIdentity(),
      title: `[On-Call] ${incident.reference} Kestrel Bank mobile payments failing (iOS + Android)`,
      platform: 'linux',
      repos: KESTREL.repos,
    });
    if (!session) {
      release();
      return incident;
    }
    incident.session = { id: session.sessionId, url: session.url };
    if (token && channel && threadTs) {
      await postThreadReply(token, channel, threadTs, `Devin is investigating: ${session.url}`, [{
        type: 'section',
        text: { type: 'mrkdwn', text: `:mag: *Devin is investigating this alert* — <${session.url}|View session> (lead on Linux; iOS and Android testing sub-sessions)` },
      }]).catch((error) => logger.error('Kestrel session link reply failed', { error: error.message }));
    }
  } catch (error) {
    release();
    logger.error('Kestrel Devin session failed', { reference: incident.reference, error: error.message });
  }
  return incident;
}

/**
 * Records a failed payment and, at most once per cooldown window, posts one
 * alert and starts one Devin session. Failures from the other platform during
 * the window join the open incident instead of raising a second one.
 */
function raiseIncident(result, { platform, release, nowMs = Date.now() } = {}) {
  if (activeIncident && nowMs - activeIncident.openedAt < ALERT_COOLDOWN_MS) {
    activeIncident.platforms.add(platform);
    activeIncident.failures += 1;
    return { incident: activeIncident, created: false, outcome: Promise.resolve(activeIncident) };
  }
  const reference = `KB-${crypto.randomBytes(3).toString('hex')}`;
  const now = new Date(nowMs);
  activeIncident = {
    reference, openedAt: nowMs, platforms: new Set([platform]), failures: 1, alert: null, session: null,
  };
  const ctx = { reference, platform, release, now };
  incrementMetric('kestrel.payments.hold_expired', { service: KESTREL.service, platform });
  Sentry.captureMessage(`${alertTitle()} (${platform})`, {
    level: 'error',
    tags: { service: KESTREL.service, platform, slug: KESTREL.slug },
    extra: { reference, durationMs: result.durationMs, release },
  });
  const outcome = runIncident(activeIncident, result, ctx);
  return { incident: activeIncident, created: true, outcome };
}

function resetIncidentsForTests() {
  activeIncident = null;
}

module.exports = {
  KESTREL,
  PAYMENT_CONFIG,
  CALM_ERROR,
  amlWindow,
  validatePayment,
  makePayment,
  platformOf,
  clientRelease,
  buildAlertMessage,
  buildSessionPrompt,
  raiseIncident,
  resetIncidentsForTests,
};
