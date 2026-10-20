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
  sources: {
    'card-controls-mobile/ios': {
      service: 'card-controls-mobile',
      platform: 'ios',
      label: 'iOS',
      brand: 'Bank of America mobile (Erica)',
    },
    'card-controls-mobile/android': {
      service: 'card-controls-mobile',
      platform: 'android',
      label: 'Android',
      brand: 'Bank of America mobile (Erica)',
    },
    'card-controls-web/desktop': {
      service: 'card-controls-web',
      platform: 'web',
      label: 'Web',
      brand: 'Bank of America Online Banking (Erica)',
    },
  },
  repos: ['COG-GTM/ios-demos', 'COG-GTM/android-demos', 'COG-GTM/event-driven-devin'],
  appDir: 'apps/e91b0f39',
  webAppDir: 'app/public/verticals/e91b0f39/',
  check: 'card_lock.duration_ms <= slo_ms',
  owner: 'Card Controls Mobile (card-controls-oncall)',
};

const REFERENCE_RE = /^CL-[0-9a-f]{6}$/;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,40}$/;
const SPAN_NAME_RE = /^[a-z0-9_.]{1,48}$/;
const REPORT_ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const EMAIL_RE = /^[^\s@<>|]{1,64}@[^\s@<>|]{1,255}$/;
const STATUS_TOKEN_RE = /^[0-9a-f]{32}$/;
const SLO_MS = 1000;
const DATADOG_WINDOW_MS = 15 * 60 * 1000;
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

function datadogLogsQuery(reference) {
  return `@slug:${CARDLOCK.slug} @reference:${reference}`;
}

function datadogLogsUrl(reference, reportedAtMs) {
  const site = (process.env.DD_SITE || 'datadoghq.com').replace(/^app\./, '');
  const fromTs = reportedAtMs - DATADOG_WINDOW_MS;
  const toTs = reportedAtMs + DATADOG_WINDOW_MS;
  return `https://app.${site}/logs?query=${encodeURIComponent(datadogLogsQuery(reference))}&from_ts=${fromTs}&to_ts=${toTs}&live=false`;
}

function sourceConfigOf(source) {
  return typeof source === 'string' && Object.prototype.hasOwnProperty.call(CARDLOCK.sources, source)
    ? CARDLOCK.sources[source]
    : null;
}

function isCardLockReport(body) {
  const sourceConfig = body && sourceConfigOf(body.source);
  return Boolean(sourceConfig) && body.service === sourceConfig.service;
}

function isOptionalCount(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0 && value <= 1000);
}

function normalizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const sourceConfig = sourceConfigOf(body.source);
  if (!sourceConfig || body.service !== sourceConfig.service) return null;

  const durationMs = body.durationMs;
  const sloMs = SLO_MS;
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 600000) return null;
  if (durationMs <= sloMs) return null;
  if (typeof body.cardLast4 !== 'string' || !/^\d{4}$/.test(body.cardLast4)) return null;

  const cardType = body.cardType === undefined ? 'debit' : body.cardType;
  if (!['debit', 'credit'].includes(cardType)) return null;
  const outcome = body.outcome === undefined ? 'success' : body.outcome;
  if (!['success', 'timeout'].includes(outcome)) return null;
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
    : `${sourceConfig.service}@unknown`;

  return {
    source: body.source,
    service: sourceConfig.service,
    platform: sourceConfig.platform,
    platformLabel: sourceConfig.label,
    brand: sourceConfig.brand,
    durationMs,
    sloMs,
    outcome,
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
  return `Card lock latency above SLO — ${report.service} (${report.platformLabel})`;
}

function whereLine(report) {
  return `${report.screen} → ${report.action} (${report.cardType} ••${report.cardLast4})`;
}

function repoLines() {
  return [
    `Repo: https://github.com/${CARDLOCK.repos[0]} (${CARDLOCK.appDir})`,
    `Repo: https://github.com/${CARDLOCK.repos[1]} (${CARDLOCK.appDir})`,
    `Repo: https://github.com/${CARDLOCK.repos[2]} (${CARDLOCK.webAppDir})`,
  ];
}

function latencyLine(report) {
  const format = (value) => value.toLocaleString('en-US');
  return `${format(report.durationMs)} ms (SLO ${format(report.sloMs)} ms)`;
}

function buildAlertMessage(report, { reference, triggeredBy, now }) {
  const lines = [
    `:rotating_light: *[Triggered] ${monitorTitle(report)}*`,
    '',
    `*Service:* ${report.service} (${report.brand})`,
    `*Where:* ${whereLine(report)}`,
    `*Latency:* ${latencyLine(report)}`,
    report.outcome === 'timeout' ? '*Outcome:* Timed out' : null,
    `*Release:* ${report.release} (${report.platformLabel})`,
    `*Owner:* ${ownerRotation(CARDLOCK.owner)}`,
    `*Incident Ref:* ${reference}`,
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
    `*Check:* \`${CARDLOCK.check}\` — failed on device`,
    '',
    `Reported: ${now.toISOString()}`,
    '',
    ...repoLines(),
  ];
  return lines.filter((line) => line !== null).join('\n');
}

function buildAlertBlocks(report, { reference, triggeredBy, now }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${monitorTitle(report)}`, emoji: true } },
    ...fieldPairs([
      ['Service', `${report.service} (${report.brand})`],
      ['Where', whereLine(report)],
      ['Latency', latencyLine(report)],
      report.outcome === 'timeout' ? ['Outcome', 'Timed out'] : null,
      ['Release', `${report.release} (${report.platformLabel})`],
      ['Owner', ownerRotation(CARDLOCK.owner)],
      ['Incident Ref', reference],
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    { type: 'section', text: { type: 'mrkdwn', text: `*Check:*\n\`${CARDLOCK.check}\` — failed on device` } },
    {
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View logs in Datadog', emoji: true },
        url: datadogLogsUrl(reference, now.getTime()),
        action_id: 'view_card_lock_datadog_logs',
      }],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: repoLines().join('\n'),
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `Service: \`${report.service}\``,
          `Reported from the ${report.platformLabel} app`,
          now.toISOString(),
          triggeredBy ? `Triggered by ${triggeredBy}` : null,
        ].filter(Boolean).join(' | '),
      }],
    },
  ].filter(Boolean);
}

function buildSessionPrompt(report, reference, { channel, threadTs, reportedAtMs = Date.now() } = {}) {
  const query = datadogLogsQuery(reference);
  const logsUrl = datadogLogsUrl(reference, reportedAtMs);
  const fromTime = new Date(reportedAtMs - DATADOG_WINDOW_MS).toISOString();
  const toTime = new Date(reportedAtMs + DATADOG_WINDOW_MS).toISOString();
  const waitSeconds = Math.round(report.durationMs / 1000);
  const impact = report.outcome === 'timeout'
    ? `Customers see a spinner for ~${waitSeconds} s and then "Something went wrong. Request timed out"; the card is not locked.`
    : `Customers locking a lost or stolen card wait ~${(report.durationMs / 1000).toFixed(1)} s on a spinner before the lock is confirmed, above the ${report.sloMs / 1000} s target.`;
  const outcomeLine = report.outcome === 'timeout' ? '*Outcome:* Timed out\n' : '';
  const prompt = `A latency SLO breach was reported by the Bank of America card-lock flow (Erica → Lock my card), from the ${report.platformLabel} client. The native iOS (SwiftUI), Android (Kotlin / Jetpack Compose), and desktop web clients share the same card-controls logic. Coordinate the fix across all three clients through child sessions and make sure guardrails land so it cannot regress.

*Alert:* ${monitorTitle(report)} — Triggered
*Incident Ref:* ${reference}
*SLO:* card lock completes within ${report.sloMs} ms — observed ${report.durationMs} ms on ${report.platformLabel}
*Where:* ${report.screen} → ${report.action} (${report.cardType} card ending ${report.cardLast4})
*Release:* ${report.release} (${report.platformLabel})${report.device ? ` | Device: ${report.device} ${report.osVersion}` : ''}
${outcomeLine}*Impact:* ${impact}
*Datadog logs:*
- Query: \`${query}\`
- Time window: ${fromTime} to ${toTime} (±15 minutes around the report)
- Logs URL: ${logsUrl}

Repositories:
- iOS: https://github.com/COG-GTM/ios-demos — apps/e91b0f39 (read its DEMO.md and the repo Makefile first)
- Android: https://github.com/COG-GTM/android-demos — apps/e91b0f39 (read its DEMO.md and the repo README first)
- Web: https://github.com/COG-GTM/event-driven-devin — app/public/verticals/e91b0f39/ (card-controls logic in js/card-controls.js)

You are the ORCHESTRATOR for this incident. Do not edit, build or run any app yourself. Your job is to diagnose, delegate one fix per client to a child Devin session, and review the results.

Steps:
1. Diagnose from Datadog first: use the Datadog MCP (search_datadog_logs) with that query to pull the breach log and client span logs for this lock, state what they show (where the time goes and how many card-controls requests one lock makes), and note that the breach log's \`spans\` field carries the per-span breakdown alongside the individual client span logs; then confirm the responsible code read-only in both native repos (DEMO.md and the shared card-controls logic) and inspect web \`js/card-controls.js\` read-only.
2. Create THREE child Devin sessions in parallel, and give each the diagnosis, including the Datadog log evidence and logs URL, plus the instructions in step 3:
   - a *macOS* child for COG-GTM/ios-demos apps/e91b0f39 (Xcode + iOS Simulator; build and test with \`make test APP=e91b0f39\`, run with \`make run APP=e91b0f39\`)
   - a *Linux* child for COG-GTM/android-demos apps/e91b0f39 (Android SDK + emulator; \`make test APP=e91b0f39\`, \`make run APP=e91b0f39\`)
   - a *Linux* child for COG-GTM/event-driven-devin app/public/verticals/e91b0f39/ (card-controls logic in \`js/card-controls.js\`; run \`npx jest tests/e91b0f39-web-card-controls.test.js\`; verify in a browser at \`http://localhost:<port>/e91b0f39?reports=off\`)
3. Each child must: (a) reproduce its native scenario on the simulator/emulator with \`make run APP=e91b0f39\`, or reproduce the web flow in a browser at \`http://localhost:<port>/e91b0f39?reports=off\`; follow the DEMO.md tap path where applicable, keep failure reports off, and time the lock; (b) apply the equivalent fix in its shared card-controls logic, keeping the recurring-payment check; keep \`LOCK_TIMEOUT_MS = 2000\` (do not raise or remove it), do not hide or reword "Something went wrong. Request timed out", do not cache, and make the fixed lock succeed in under 1 s; (c) add guardrail tests that fail before and pass after, assert completion under the SLO and bound card-controls requests, and run the platform's test command; (d) record BEFORE/AFTER of the lock flow; (e) open a *draft* PR against main titled \`[DEMO — DO NOT MERGE] ...\`, touching only its assigned app directory and relevant tests, and report the PR link, test output and before/after lock times. For the web child, run \`npx jest tests/e91b0f39-web-card-controls.test.js\`, verify in the browser at \`http://localhost:<port>/e91b0f39?reports=off\`, and touch only app/public/verticals/e91b0f39/ and that test. Never merge: main keeps the unfixed behavior so the demo can be re-run. Never launch an app with reports enabled (no \`make demo\`, no \`-demoReports on\`, no \`--ez demoReports true\`).
4. Wait for all three children to finish. Review all three PRs: the iOS, Android and web fixes must be equivalent and each must include guardrail tests. Send any corrections back to the child that owns the PR and wait for its update.
5. Reply ONCE in the Slack alert thread below with the diagnosis, fix, all three PR links, guardrails added, before/after lock times on iOS, Android and web, Datadog evidence including span numbers, and the Datadog logs link.
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

async function triggerDevinSession(report, reference, { token, channel, threadTs, reportedAtMs }) {
  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('Card lock Devin session creation throttled', { reference, ...cap });
    return null;
  }

  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildSessionPrompt(report, reference, { channel, threadTs, reportedAtMs }), {
      ...resolveSessionIdentity(),
      title: `[On-Call] ${reference} Card lock latency above SLO (${report.service})`,
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
            text: `:mag: *Devin is investigating this alert* — <${session.url}|View session> (orchestrator — macOS child for ios-demos, Linux children for android-demos and web)`,
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
    const duplicate = Array.from(reports.values()).find(
      (entry) => entry.source === report.source && entry.reportId === reportId,
    );
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
    source: report.source,
    service: report.service,
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
    service: report.service,
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
    check: CARDLOCK.check,
    slug: CARDLOCK.slug,
    service: report.service,
    platform: report.platform,
    source: report.source,
    release: report.release,
    device: report.device,
    osVersion: report.osVersion,
    cardType: report.cardType,
    cardLast4: report.cardLast4,
    durationMs: report.durationMs,
    sloMs: SLO_MS,
    requestCount: report.requestCount,
    merchantCount: report.merchantCount,
    reportId: report.reportId,
    outcome: report.outcome,
    spans: report.spans.map((s) => ({
      name: s.name,
      count: s.count,
      totalMs: s.totalMs,
      avgMs: s.count > 0 ? Math.round(s.totalMs / s.count) : null,
    })),
  });
  for (const span of report.spans) {
    logger.info('Card lock client span', {
      reference,
      check: CARDLOCK.check,
      slug: CARDLOCK.slug,
      platform: report.platform,
      release: report.release,
      span: span.name,
      count: span.count,
      totalMs: span.totalMs,
      avgMs: span.count > 0 ? Math.round(span.totalMs / span.count) : null,
    });
  }
  Sentry.captureMessage(`${monitorTitle(report)} (${report.service}/${report.platform})`, {
    level: 'error',
    tags,
    extra: {
      reference,
      release: report.release,
      durationMs: report.durationMs,
      sloMs: report.sloMs,
      outcome: report.outcome,
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
        reportedAtMs: now.getTime(),
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
    service: entry.service,
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
  datadogLogsQuery,
  datadogLogsUrl,
  reportLockLatency,
  getLockLatencyStatus,
};
