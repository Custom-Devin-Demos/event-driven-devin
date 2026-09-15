const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { OWNER_DISCLAIMER, postMessage, postThreadReply, lookupSlackUserByEmail } = require('../slack');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

/**
 * Fleet mobile (26a3d261) — failure reports from the native SwiftUI Samsara
 * Fleet replica in COG-GTM/ios-demos.
 *
 * The app has no telemetry SDK: when its primary action ("Share live ETA")
 * fails an invariant on-device, it POSTs the facts it has — asset, route,
 * departure, the arrival it computed — to /api/oncall/26a3d261/eta-failure.
 * This module owns everything the app must not: the Slack token, the Devin
 * service key, the alert copy and the investigation prompt. It posts one
 * alert card to the On-Call alerts channel, creates one Devin session on a
 * macOS machine (the app only builds with Xcode) and links the session in
 * the alert thread.
 *
 * Only bounded scalar facts are accepted from the client; free text is
 * clipped and stripped of Slack markup, and the prompt never carries
 * request-controlled text beyond those facts.
 */

const FLEET = {
  slug: '26a3d261',
  service: 'fleet-mobile',
  brand: 'Samsara Fleet (mobile)',
  sourcePrefix: 'fleet-mobile/',
  platforms: new Set(['ios', 'macos']),
  repo: 'https://github.com/COG-GTM/ios-demos',
  repoName: 'COG-GTM/ios-demos',
  appDir: 'apps/26a3d261',
  monitor: 'Live Share ETA equals dispatch time',
  check: 'live_share.eta_after_departure',
  owner: 'Priya Natarajan (fleet-mobile-oncall)',
  symptom: 'Tapping "Share live ETA" on an asset produces an arrival equal to the current fleet time (0 min out) '
    + 'while the same route\'s stop list shows a later destination ETA. The app refuses to publish the share and reports the failure.',
  impact: 'Dispatchers cannot send customers a live ETA; any link that did go out shows the wrong arrival and expires early.',
};

const PLATFORM_LABELS = { ios: 'iOS', macos: 'macOS' };

// Devin platform label the investigation runs on. The app is native
// SwiftUI: only a macOS machine with Xcode can build and reproduce it.
const SESSION_PLATFORM = () => process.env.DEVIN_ONCALL_FLEET_PLATFORM || 'macos';

const REFERENCE_RE = /^FLT-[0-9a-f]{6}$/;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,63}$/;
const ID_RE = /^[0-9]{1,12}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EMAIL_RE = /^[^\s@<>|]{1,64}@[^\s@<>|]{1,255}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// Recent reports, so the app can poll for the alert/session outcome and
// show "Devin is investigating" on the failure card.
const REPORT_TTL_MS = 6 * 60 * 60 * 1000;
const REPORT_MAX = 200;
const reports = new Map();

function pruneReports() {
  const cutoff = Date.now() - REPORT_TTL_MS;
  for (const [reference, entry] of reports) {
    if (entry.receivedAt < cutoff) reports.delete(reference);
  }
  while (reports.size > REPORT_MAX) {
    reports.delete(reports.keys().next().value);
  }
}

function makeReference() {
  return `FLT-${crypto.randomBytes(3).toString('hex')}`;
}

function clip(value, max) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}<>&|`]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function platformOf(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  if (!source.startsWith(FLEET.sourcePrefix)) return null;
  const platform = source.slice(FLEET.sourcePrefix.length);
  return FLEET.platforms.has(platform) ? platform : null;
}

function isFleetReport(body) {
  return Boolean(body) && platformOf(body) !== null && body.service === FLEET.service;
}

/**
 * Reduce a client report to the bounded facts the alert and prompt use.
 * Returns null when the required facts (asset, departure, arrival) are
 * missing or malformed, or when the arrival is after departure — that is a
 * healthy ETA, not the failed invariant this endpoint exists for.
 */
function normalizeReport(body) {
  if (!body || typeof body !== 'object') return null;
  const platform = platformOf(body);
  const departure = parseDate(body.departure);
  const arrival = parseDate(body.arrival);
  const assetId = typeof body.assetId === 'string' && ID_RE.test(body.assetId) ? body.assetId : null;
  if (!platform || !departure || !arrival || !assetId) return null;
  if (arrival.getTime() > departure.getTime()) return null;

  const release = typeof body.release === 'string' && RELEASE_RE.test(body.release)
    ? body.release
    : `${FLEET.service}@unknown`;
  const orgId = typeof body.orgId === 'string' && ID_RE.test(body.orgId) ? body.orgId : null;
  const timeZone = typeof body.timeZone === 'string' && /^[A-Za-z_]+(?:\/[A-Za-z_+-]+)*$/.test(body.timeZone)
    ? body.timeZone
    : 'UTC';

  return {
    platform,
    platformLabel: PLATFORM_LABELS[platform],
    release,
    orgId,
    assetId,
    driver: clip(body.driver, 60),
    routeName: clip(body.routeName, 80),
    destination: clip(body.destination, 80),
    screen: typeof body.screen === 'string' && TOKEN_RE.test(body.screen) ? body.screen : 'asset',
    action: typeof body.action === 'string' && TOKEN_RE.test(body.action) ? body.action : 'share_live_eta',
    departure,
    arrival,
    minutesOut: Math.round((arrival.getTime() - departure.getTime()) / 60000),
    timeZone,
    devinEmail: typeof body.devinEmail === 'string' && EMAIL_RE.test(body.devinEmail) ? body.devinEmail : null,
  };
}

function resolveOncallEnv() {
  return {
    token: process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN,
    alertsChannel: process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID,
  };
}

function formatClock(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone, timeZoneName: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

async function resolveTriggeredBy(token, devinEmail) {
  if (!devinEmail) return null;
  try {
    const memberId = await lookupSlackUserByEmail(token, devinEmail);
    return memberId ? `<@${memberId}>` : devinEmail;
  } catch (error) {
    logger.warn('Fleet triggered-by Slack lookup failed', { error: error.message });
    return devinEmail;
  }
}

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

function monitorTitle(report) {
  return `${FLEET.monitor} — ${FLEET.service} (${report.platformLabel})`;
}

function routeLine(report) {
  const parts = [`Asset ${report.assetId}`];
  if (report.driver) parts.push(report.driver);
  if (report.routeName) parts.push(report.routeName);
  if (report.destination) parts.push(`→ ${report.destination}`);
  return parts.join(' · ');
}

function etaLine(report) {
  const departure = formatClock(report.departure, report.timeZone);
  const arrival = formatClock(report.arrival, report.timeZone);
  return `departure ${departure} → computed arrival ${arrival} (${report.minutesOut} min)`;
}

/**
 * Alert card. Every number on it came from the device that failed; the
 * only synthetic element is the on-call persona, labelled as such.
 */
function buildAlertMessage(report, { reference, triggeredBy, now }) {
  const lines = [
    `:rotating_light: *[Triggered] ${monitorTitle(report)}*`,
    '',
    `*Service:* ${FLEET.service} (${FLEET.brand})`,
    `*Check:* \`${FLEET.check}\` — failed on device (client-side invariant: arrival must be after departure)`,
    `*Where:* ${report.screen} → ${report.action}`,
    `*Trip:* ${routeLine(report)}`,
    `*ETA:* ${etaLine(report)}`,
    `*Owner:* ${FLEET.owner} — ${OWNER_DISCLAIMER}`,
    `*Incident Ref:* ${reference}`,
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
    '',
    `Env: production | Release: ${report.release} | Platform: ${report.platformLabel}${report.orgId ? ` | Org: ${report.orgId}` : ''}`,
    `Reported: ${now.toISOString()}`,
    '',
    `*Symptom:* ${FLEET.symptom}`,
    `*Impact:* ${FLEET.impact}`,
    `Repo: ${FLEET.repo} (${FLEET.appDir})`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function buildAlertBlocks(report, { reference, triggeredBy, now }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${monitorTitle(report)}`, emoji: true } },
    ...fieldPairs([
      ['Service', `${FLEET.service} (${FLEET.brand})`],
      ['Where', `${report.screen} → ${report.action}`],
      ['Trip', routeLine(report)],
      ['ETA', etaLine(report)],
      ['Release', `${report.release} (${report.platformLabel})`],
      ['Owner', `${FLEET.owner} — ${OWNER_DISCLAIMER}`],
      ['Incident Ref', reference],
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    { type: 'section', text: { type: 'mrkdwn', text: `*Check:*\n\`\`\`${FLEET.check} — failed on device (arrival must be after departure)\`\`\`` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Symptom:* ${FLEET.symptom}\n*Impact:* ${FLEET.impact}\nRepo: ${FLEET.repo} (${FLEET.appDir})`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `Service: \`${FLEET.service}\``,
          `Reported from the ${report.platformLabel} app`,
          now.toISOString(),
          triggeredBy ? `Triggered by ${triggeredBy}` : null,
        ].filter(Boolean).join(' | '),
      }],
    },
  ];
}

/**
 * Investigation prompt. Built from the same facts the alert shows plus the
 * build/verify instructions the app's Makefile documents — no code
 * locations, so the session finds the cause by reproducing it.
 */
function buildSessionPrompt(report, reference) {
  return [
    `A customer-visible defect was reported by the ${FLEET.brand} app — a native SwiftUI iOS/macOS app. Investigate it and open a PR with the fix.`,
    '',
    `*Alert:* ${monitorTitle(report)} — Triggered`,
    `*Incident Ref:* ${reference}`,
    `*Check:* \`${FLEET.check}\` failed on device (arrival must be after departure)`,
    `*Where:* ${report.screen} → ${report.action}`,
    `*Trip:* ${routeLine(report)}`,
    `*ETA:* ${etaLine(report)} — departure ${report.departure.toISOString()}, arrival ${report.arrival.toISOString()}`,
    `*Release:* ${report.release} (${report.platformLabel})`,
    `*Symptom:* ${FLEET.symptom}`,
    `*Impact:* ${FLEET.impact}`,
    '',
    `Repository: ${FLEET.repo} — the app is ${FLEET.appDir} (read its DEMO.md and the repo Makefile first).`,
    `Reproduce it on this macOS machine: \`APP=${FLEET.slug} make run\` (iOS Simulator) or \`APP=${FLEET.slug} make run-mac\` (native macOS), then Fleet map → asset ${report.assetId} → Share live ETA.`,
    `Run the tests serially with \`APP=${FLEET.slug} make test\` — never start a second xcodebuild while one is running, and interrupt any xcodebuild that exceeds three minutes.`,
    'Find the root cause, add a regression test that fails before and passes after, prove the fix with a before/after screen recording on the Simulator, and open a fix PR against main. Do not merge or deploy anything: the PR is the end state and a human reviews it.',
  ].join('\n');
}

function resolveSessionIdentity() {
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
    apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
  };
}

/**
 * Create the investigation session and link it in the alert thread. Never
 * throws: a failed session must not fail the alert that triggered it.
 */
async function triggerDevinSession(report, reference, { token, channel, threadTs }) {
  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('Fleet Devin session creation throttled', { reference, ...cap });
    return null;
  }

  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildSessionPrompt(report, reference), {
      ...resolveSessionIdentity(),
      title: `[On-Call] ${reference} ${FLEET.monitor} (${FLEET.service})`,
      platform: SESSION_PLATFORM(),
      repos: [FLEET.repoName],
    });
  } catch (error) {
    logger.error('Fleet Devin session failed', { reference, error: error.message });
  }

  if (!session) {
    release();
    return null;
  }

  logger.info('Fleet Devin session created', { reference, sessionId: session.sessionId });

  if (token && channel && threadTs) {
    try {
      await postThreadReply(token, channel, threadTs, `Devin is investigating: ${session.url}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `:mag: *Devin is investigating this alert* — <${session.url}|View session> (macOS, ${FLEET.repoName})` } },
      ]);
    } catch (error) {
      logger.error('Fleet session link reply failed', { reference, error: error.message });
    }
  }

  return session;
}

/**
 * Handle a normalized failure report from the app: record it, post the
 * alert card, create the Devin session and link it in the thread. Returns
 * the reference synchronously; the Slack/Devin work continues in `outcome`,
 * which always settles the status entry (`done`, plus `error` on failure).
 */
function reportEtaFailure(report) {
  if (!report || !report.platform || !report.assetId) return null;

  const reference = makeReference();
  const now = new Date();
  const entry = {
    reference,
    receivedAt: now.getTime(),
    platform: report.platform,
    assetId: report.assetId,
    alert: null,
    session: null,
    error: null,
    done: false,
  };
  pruneReports();
  reports.set(reference, entry);

  logger.error('Fleet mobile ETA failure reported', {
    reference,
    platform: report.platform,
    release: report.release,
    assetId: report.assetId,
    departure: report.departure.toISOString(),
    arrival: report.arrival.toISOString(),
    minutesOut: report.minutesOut,
  });

  const outcome = (async () => {
    try {
      const { token, alertsChannel } = resolveOncallEnv();
      let alertTs = null;
      if (!token || !alertsChannel) {
        entry.error = 'alerts channel not configured';
        logger.warn('On-Call alerts channel not configured — Fleet alert not posted', { reference });
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
          logger.info('Fleet On-Call alert posted', { reference, channel: alertsChannel, ts: alertTs });
        } catch (error) {
          entry.error = 'alert failed';
          logger.error('Fleet On-Call alert failed', { reference, error: error.message });
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
      logger.error('Fleet ETA failure pipeline failed', { reference, error: error.message });
    } finally {
      entry.done = true;
    }
    return entry;
  })();

  return { reference, outcome };
}

/** Public view of a report's outcome, for the app's status poll. */
function getEtaFailureStatus(reference) {
  if (typeof reference !== 'string' || !REFERENCE_RE.test(reference)) return null;
  pruneReports();
  const entry = reports.get(reference);
  if (!entry) return null;
  return {
    reference: entry.reference,
    service: FLEET.service,
    alertPosted: Boolean(entry.alert),
    sessionUrl: entry.session ? entry.session.url : null,
    done: entry.done,
    error: entry.error,
  };
}

module.exports = {
  FLEET,
  isFleetReport,
  normalizeReport,
  buildAlertMessage,
  buildAlertBlocks,
  buildSessionPrompt,
  reportEtaFailure,
  getEtaFailureStatus,
};
