const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');
const { incrementMetric } = require('../../telemetry/datadog');
const { ownerRotation, postMessage, postThreadReply, lookupSlackUserByEmail } = require('../slack');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

const CARDLOCK = {
  slug: 'e91b0f39',
  service: 'card-controls-mobile',
  brand: 'Bank of America mobile (Erica)',
  sourcePrefix: 'card-controls-mobile/',
  platforms: ['ios', 'android'],
  repos: ['COG-GTM/ios-demos', 'COG-GTM/android-demos'],
  appDir: 'apps/e91b0f39',
  check: 'card_lock.duration_ms <= slo_ms',
  owner: 'Card Controls Mobile (card-controls-oncall)',
};

const PLATFORM_LABELS = { ios: 'iOS', android: 'Android' };
const REFERENCE_RE = /^CL-[0-9a-f]{6}$/;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SPAN_NAME_RE = /^[a-z0-9_.]{1,48}$/;
const REPORT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const EMAIL_RE = /^[^\s@<>|]{1,64}@[^\s@<>|]{1,255}$/;
const STATUS_TOKEN_RE = /^[0-9a-f]{32}$/;
const SLO_MS = 3000;
const REPORT_TTL_MS = 6 * 60 * 60 * 1000;
const REPORT_MAX = 200;
const reports = new Map();

function pruneReports() {
  const cutoff = Date.now() - REPORT_TTL_MS;
  for (const [reference, entry] of reports) {
    if (entry.receivedAt < cutoff) reports.delete(reference);
  }
  if (reports.size <= REPORT_MAX) return;
  for (const [reference, entry] of reports) {
    if (reports.size <= REPORT_MAX) return;
    if (entry.done) reports.delete(reference);
  }
  while (reports.size > REPORT_MAX) {
    reports.delete(reports.keys().next().value);
  }
}

function makeReference() {
  let reference;
  do {
    reference = `CL-${crypto.randomBytes(3).toString('hex')}`;
  } while (reports.has(reference));
  return reference;
}

function makeStatusToken() {
  return crypto.randomBytes(16).toString('hex');
}

function tokenMatches(expected, supplied) {
  if (typeof supplied !== 'string' || !STATUS_TOKEN_RE.test(supplied)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(supplied, 'hex'));
}

function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}<>&|`]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function platformOf(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  if (!source.startsWith(CARDLOCK.sourcePrefix)) return null;
  const platform = source.slice(CARDLOCK.sourcePrefix.length);
  return CARDLOCK.platforms.includes(platform) ? platform : null;
}

function isCardLockReport(body) {
  return Boolean(body) && platformOf(body) !== null && body.service === CARDLOCK.service;
}

function isOptionalCount(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 1000);
}

function normalizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const platform = platformOf(body);
  if (!platform || body.service !== CARDLOCK.service) return null;

  const durationMs = body.durationMs;
  const sloMs = SLO_MS;
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 600000) return null;
  if (durationMs <= sloMs) return null;
  if (typeof body.cardLast4 !== 'string' || !/^\d{4}$/.test(body.cardLast4)) return null;

  const cardType = body.cardType === undefined ? 'debit' : body.cardType;
  if (!['debit', 'credit'].includes(cardType)) return null;
  if (!isOptionalCount(body.requestCount) || !isOptionalCount(body.merchantCount)) return null;
  if (Array.isArray(body.spans) && body.spans.length > 20) return null;

  const spans = Array.isArray(body.spans)
    ? body.spans.filter((span) => span
      && typeof span === 'object'
      && typeof span.name === 'string'
      && SPAN_NAME_RE.test(span.name)
      && Number.isInteger(span.count)
      && span.count >= 0
      && span.count <= 1000
      && Number.isInteger(span.totalMs)
      && span.totalMs >= 0
      && span.totalMs <= 600000)
      .slice(0, 6)
      .map(({ name, count, totalMs }) => ({ name, count, totalMs }))
    : [];

  const release = typeof body.release === 'string' && RELEASE_RE.test(body.release)
    ? body.release
    : `${CARDLOCK.service}@unknown`;

  return {
    platform,
    platformLabel: PLATFORM_LABELS[platform],
    durationMs,
    sloMs,
    cardLast4: body.cardLast4,
    cardType,
    reportId: typeof body.reportId === 'string' && REPORT_ID_RE.test(body.reportId) ? body.reportId : null,
    requestCount: body.requestCount === undefined ? null : body.requestCount,
    merchantCount: body.merchantCount === undefined ? null : body.merchantCount,
    spans,
    screen: typeof body.screen === 'string' && TOKEN_RE.test(body.screen) ? body.screen : 'erica',
    action: typeof body.action === 'string' && TOKEN_RE.test(body.action) ? body.action : 'lock_card',
    release,
    device: clip(body.device, 40),
    osVersion: clip(body.osVersion, 20),
    devinEmail: typeof body.devinEmail === 'string' && EMAIL_RE.test(body.devinEmail) ? body.devinEmail : null,
  };
}

function resolveOncallEnv() {
  return {
    token: process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN,
    alertsChannel: process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
  };
}

async function resolveTriggeredBy(token, devinEmail) {
  if (!devinEmail) return null;
  try {
    const memberId = await lookupSlackUserByEmail(token, devinEmail);
    return memberId ? `<@${memberId}>` : devinEmail;
  } catch (error) {
    logger.warn('Card lock triggered-by Slack lookup failed', { error: error.message });
    return devinEmail;
  }
}

function fieldPairs(pairs) {
  const fields = pairs
    .filter((pair) => pair && pair[1])
    .map(([label, value]) => ({ type: 'mrkdwn', text: `*${label}:*\n${value}` }));
  const blocks = [];
  for (let i = 0; i < fields.length; i += 2) {
    blocks.push({ type: 'section', fields: fields.slice(i, i + 2) });
  }
  return blocks;
}

function monitorTitle(report) {
  return `Card lock latency above SLO — ${CARDLOCK.service} (${report.platformLabel})`;
}

function whereLine(report) {
  return `${report.screen} → ${report.action} (${report.cardType} ••${report.cardLast4})`;
}

function latencyLine(report) {
  const format = (value) => value.toLocaleString('en-US');
  return `${format(report.durationMs)} ms (SLO ${format(report.sloMs)} ms)`;
}

function spanLines(report) {
  return report.spans.map((span) => `${span.name} ×${span.count} — ${span.totalMs} ms`);
}

function buildAlertMessage(report, { reference, triggeredBy, now }) {
  const spans = spanLines(report);
  const lines = [
    `:rotating_light: *[Triggered] ${monitorTitle(report)}*`,
    '',
    `*Service:* ${CARDLOCK.service} (${CARDLOCK.brand})`,
    `*Where:* ${whereLine(report)}`,
    `*Latency:* ${latencyLine(report)}`,
    report.requestCount === null ? null : `*Requests:* ${report.requestCount} card-controls calls`,
    spans.length ? `*Spans:* ${spans[0]}` : null,
    ...spans.slice(1),
    `*Release:* ${report.release} (${report.platformLabel})`,
    `*Owner:* ${ownerRotation(CARDLOCK.owner)}`,
    `*Incident Ref:* ${reference}`,
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
    `*Check:* \`${CARDLOCK.check}\` — failed on device`,
    '',
    `Reported: ${now.toISOString()}`,
    '',
    `Repo: https://github.com/${CARDLOCK.repos[0]} (${CARDLOCK.appDir})`,
    `Repo: https://github.com/${CARDLOCK.repos[1]} (${CARDLOCK.appDir})`,
  ];
  return lines.filter((line) => line !== null).join('\n');
}

function buildAlertBlocks(report, { reference, triggeredBy, now }) {
  const spans = spanLines(report);
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${monitorTitle(report)}`, emoji: true } },
    ...fieldPairs([
      ['Service', `${CARDLOCK.service} (${CARDLOCK.brand})`],
      ['Where', whereLine(report)],
      ['Latency', latencyLine(report)],
      report.requestCount === null ? null : ['Requests', `${report.requestCount} card-controls calls`],
      ['Release', `${report.release} (${report.platformLabel})`],
      ['Owner', ownerRotation(CARDLOCK.owner)],
      ['Incident Ref', reference],
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    spans.length ? { type: 'section', text: { type: 'mrkdwn', text: `*Spans:*\n${spans.join('\n')}` } } : null,
    { type: 'section', text: { type: 'mrkdwn', text: `*Check:*\n\`${CARDLOCK.check}\` — failed on device` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Repo: https://github.com/${CARDLOCK.repos[0]} (${CARDLOCK.appDir})\nRepo: https://github.com/${CARDLOCK.repos[1]} (${CARDLOCK.appDir})`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `Service: \`${CARDLOCK.service}\``,
          `Reported from the ${report.platformLabel} app`,
          now.toISOString(),
          triggeredBy ? `Triggered by ${triggeredBy}` : null,
        ].filter(Boolean).join(' | '),
      }],
    },
  ].filter(Boolean);
}

function buildSessionPrompt(report, reference, { channel, threadTs } = {}) {
  const prompt = `A latency SLO breach was reported by the Bank of America mobile app (Erica → Lock my card). The app has native iOS (SwiftUI) and Android (Kotlin / Jetpack Compose) clients that share the same card-controls client logic. Coordinate the fix on BOTH platforms through child sessions and make sure guardrails land so it cannot regress.

*Alert:* ${monitorTitle(report)} — Triggered
*Incident Ref:* ${reference}
*SLO:* card lock completes within ${report.sloMs} ms — observed ${report.durationMs} ms on ${report.platformLabel}
*Where:* ${report.screen} → ${report.action} (${report.cardType} card ending ${report.cardLast4})
*Requests during the lock:* ${report.requestCount === null ? 'not reported' : report.requestCount} card-controls calls
*Spans:* ${report.spans.map((span) => `${span.name} ×${span.count} = ${span.totalMs} ms`).join('; ')}
*Release:* ${report.release} (${report.platformLabel})${report.device ? ` | Device: ${report.device} ${report.osVersion}` : ''}
*Impact:* Customers locking a lost or stolen card wait ~10 s on a spinner before the lock is confirmed; some abandon and call the card services line.

Repositories (same app folder in both):
- iOS: https://github.com/COG-GTM/ios-demos — apps/e91b0f39 (read its DEMO.md and the repo Makefile first)
- Android: https://github.com/COG-GTM/android-demos — apps/e91b0f39 (read its DEMO.md and the repo README first)

You are the ORCHESTRATOR for this incident. Do not edit, build or run either app yourself. Your job is to diagnose, delegate one fix per platform to a child Devin session, and review the results.

Steps:
1. Read both apps (read-only): DEMO.md and the shared card-controls logic in each repo. From the telemetry above and the code, identify the root cause and write a short diagnosis that names the code responsible and the fix approach. The fix must keep the recurring-payment check and must not hide the spinner, add a timeout or return a cached result.
2. Create TWO child Devin sessions in parallel, and give each the diagnosis plus the instructions in step 3:
   - a *macOS* child for COG-GTM/ios-demos apps/e91b0f39 (Xcode + iOS Simulator; build and test with \`make test APP=e91b0f39\`, run with \`make run APP=e91b0f39\`)
   - a *Linux* child for COG-GTM/android-demos apps/e91b0f39 (Android SDK + emulator; \`make test APP=e91b0f39\`, \`make run APP=e91b0f39\`)
3. Each child must: (a) reproduce on its simulator/emulator with \`make run APP=e91b0f39\` (failure reports stay off) following the tap path in DEMO.md, and time the lock; (b) apply the fix in the shared card-controls logic; (c) add guardrail unit tests that fail before and pass after, asserting the lock completes within the SLO budget and bounding the number of card-controls requests, and run \`make test APP=e91b0f39\`; (d) record BEFORE/AFTER of the lock flow on the simulator/emulator; (e) open a *draft* PR against main titled \`[DEMO — DO NOT MERGE] ...\`, touching only apps/e91b0f39/, and report the PR link, test output and before/after lock times. Never merge: main keeps the unfixed app so the demo can be re-run. Never launch the app with failure reports on (no \`make demo\`, no \`-demoReports on\`, no \`--ez demoReports true\`).
4. Wait for both children to finish. Review both PRs: the iOS and Android fixes must be equivalent and both must include the guardrail tests. Send any corrections back to the child that owns the PR and wait for its update.
5. Reply ONCE in the Slack alert thread below with the root cause, the fix, both PR links, the guardrails added, and the before/after lock times on iOS and Android.
`;
  if (channel && threadTs) {
    return `${prompt}\n\n*Slack Thread:* channel=${channel} thread_ts=${threadTs}`;
  }
  return prompt;
}

function resolveSessionIdentity() {
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
    apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
  };
}

async function triggerDevinSession(report, reference, { token, channel, threadTs }) {
  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('Card lock Devin session creation throttled', { reference, ...cap });
    return null;
  }

  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildSessionPrompt(report, reference, { channel, threadTs }), {
      ...resolveSessionIdentity(),
      title: `[On-Call] ${reference} Card lock latency above SLO (${CARDLOCK.service})`,
      platform: process.env.DEVIN_ONCALL_CARDLOCK_PLATFORM || 'linux',
      repos: CARDLOCK.repos,
    });
  } catch (error) {
    logger.error('Card lock Devin session failed', { reference, error: error.message });
  }

  if (!session) {
    release();
    return null;
  }

  logger.info('Card lock Devin session created', { reference, sessionId: session.sessionId });
  if (token && channel && threadTs) {
    try {
      await postThreadReply(token, channel, threadTs, `Devin is investigating: ${session.url}`, [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `:mag: *Devin is investigating this alert* — <${session.url}|View session> (orchestrator — macOS child for ${CARDLOCK.repos[0]}, Linux child for ${CARDLOCK.repos[1]})`,
          },
        },
      ]);
    } catch (error) {
      logger.error('Card lock session link reply failed', { reference, error: error.message });
    }
  }
  return session;
}

function reportLockLatency(report) {
  if (!report || !report.platform || !Number.isInteger(report.durationMs) || report.durationMs <= SLO_MS) return null;

  pruneReports();
  const reportId = typeof report.reportId === 'string' && REPORT_ID_RE.test(report.reportId)
    ? report.reportId
    : null;
  if (reportId) {
    const duplicate = Array.from(reports.values()).find((entry) => entry.reportId === reportId);
    if (duplicate) {
      return { reference: duplicate.reference, statusToken: null, duplicate: true };
    }
  }

  const reference = makeReference();
  const statusToken = makeStatusToken();
  const now = new Date();
  const entry = {
    reference,
    statusToken,
    receivedAt: now.getTime(),
    platform: report.platform,
    durationMs: report.durationMs,
    reportId,
    alert: null,
    session: null,
    error: null,
    done: false,
  };
  reports.set(reference, entry);

  const tags = {
    route: `/api/oncall/${CARDLOCK.slug}/lock-latency`,
    service: CARDLOCK.service,
    check: CARDLOCK.check,
    platform: report.platform,
    screen: report.screen,
    action: report.action,
  };
  incrementMetric('card_lock.latency_slo_breach', {
    route: tags.route,
    platform: report.platform,
    check: CARDLOCK.check,
  });
  logger.error('Card lock latency SLO breach reported', {
    reference,
    platform: report.platform,
    release: report.release,
    durationMs: report.durationMs,
    sloMs: report.sloMs,
  });
  Sentry.captureMessage(`${monitorTitle(report)} (${CARDLOCK.service}/${report.platform})`, {
    level: 'error',
    tags,
    extra: {
      reference,
      release: report.release,
      durationMs: report.durationMs,
      sloMs: report.sloMs,
    },
  });

  const outcome = (async () => {
    try {
      const { token, alertsChannel } = resolveOncallEnv();
      let alertTs = null;
      if (!token || !alertsChannel) {
        entry.error = 'alerts channel not configured';
        logger.warn('On-Call alerts channel not configured — card lock alert not posted', { reference });
      } else {
        const triggeredBy = await resolveTriggeredBy(token, report.devinEmail);
        try {
          alertTs = await postMessage(
            token,
            alertsChannel,
            buildAlertMessage(report, { reference, triggeredBy, now }),
            buildAlertBlocks(report, { reference, triggeredBy, now }),
          );
          entry.alert = { channel: alertsChannel, ts: alertTs };
          logger.info('Card lock On-Call alert posted', { reference, channel: alertsChannel, ts: alertTs });
        } catch (error) {
          entry.error = 'alert failed';
          logger.error('Card lock On-Call alert failed', { reference, error: error.message });
        }
      }

      const session = await triggerDevinSession(report, reference, {
        token,
        channel: alertsChannel,
        threadTs: alertTs,
      });
      if (session) {
        entry.session = { id: session.sessionId, url: session.url };
      } else if (!entry.error) {
        entry.error = 'session not created';
      }
    } catch (error) {
      entry.error = 'pipeline failed';
      logger.error('Card lock latency pipeline failed', { reference, error: error.message });
    } finally {
      entry.done = true;
    }
    return entry;
  })();

  return { reference, statusToken, outcome };
}

function getLockLatencyStatus(reference, statusToken) {
  if (typeof reference !== 'string' || !REFERENCE_RE.test(reference)) return null;
  pruneReports();
  const entry = reports.get(reference);
  if (!entry || !tokenMatches(entry.statusToken, statusToken)) return null;
  return {
    reference: entry.reference,
    service: CARDLOCK.service,
    alertPosted: Boolean(entry.alert),
    sessionUrl: entry.session ? entry.session.url : null,
    done: entry.done,
    error: entry.error,
  };
}

module.exports = {
  CARDLOCK,
  isCardLockReport,
  normalizeReport,
  buildAlertMessage,
  buildAlertBlocks,
  buildSessionPrompt,
  reportLockLatency,
  getLockLatencyStatus,
};
