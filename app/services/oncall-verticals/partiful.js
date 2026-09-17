const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');
const { incrementMetric } = require('../../telemetry/datadog');
const { OWNER_DISCLAIMER, postMessage, postThreadReply, lookupSlackUserByEmail } = require('../slack');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

/**
 * Partiful RSVP (205bc15f) — failure reports from the native SwiftUI
 * Partiful replica in COG-GTM/ios-demos.
 *
 * The app has no telemetry SDK: when an invited guest opens an event and
 * the RSVP page cannot be built, it POSTs the facts it has — event, host,
 * theme, reason code, guest counts — to
 * /api/oncall/205bc15f/rsvp-page-failure. This module owns everything the
 * app must not: the Slack token, the Devin service key, the alert copy and
 * the investigation prompt. It posts one alert card to the On-Call alerts
 * channel, creates one Devin session on a macOS machine (the app only
 * builds with Xcode) and links the session in the alert thread.
 *
 * Only bounded scalar facts are accepted from the client; free text is
 * clipped and stripped of Slack markup, and the prompt never carries
 * request-controlled text beyond those facts.
 */

const PARTIFUL = {
  slug: '205bc15f',
  service: 'partiful-rsvp',
  brand: 'Partiful (mobile)',
  sourcePrefix: 'partiful-rsvp/',
  platforms: new Set(['ios', 'macos', 'web']),
  repo: 'https://github.com/COG-GTM/ios-demos',
  repoName: 'COG-GTM/ios-demos',
  appDir: 'apps/205bc15f',
  check: 'rsvp_page.rendered',
  owner: 'Dana Whitfield (guest-experience-oncall)',
  impact: 'Invited guests open the invite link and see an empty page: no date, no venue, no RSVP buttons. '
    + 'They cannot respond and the host sees no replies coming in.',
};

const PLATFORM_LABELS = { ios: 'iOS', macos: 'macOS', web: 'Web (phone preview)' };

// Reason codes the app can report, with the human symptom each one means.
// Anything else is rejected: the prompt must never carry a client string
// it cannot explain.
const REASONS = {
  missing_cover_photo: {
    monitor: 'RSVP page failed to render — no cover photo',
    symptom: 'Opening an event whose host picked a text-only theme (no cover photo uploaded) renders a blank RSVP page. '
      + 'Events with a cover photo render normally.',
  },
};

// Devin platform label the investigation runs on. The app is native
// SwiftUI: only a macOS machine with Xcode can build and reproduce it.
const SESSION_PLATFORM = () => process.env.DEVIN_ONCALL_PARTIFUL_PLATFORM || 'macos';

const REFERENCE_RE = /^PTF-[0-9a-f]{6}$/;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,63}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,40}$/;
const EMAIL_RE = /^[^\s@<>|]{1,64}@[^\s@<>|]{1,255}$/;
const STATUS_TOKEN_RE = /^[0-9a-f]{32}$/;

// Recent reports, so the app can poll for the alert/session outcome and
// show "Devin is investigating" on the blank page.
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
    reference = `PTF-${crypto.randomBytes(3).toString('hex')}`;
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

function count(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100000 ? value : null;
}

// The invite link is shown on the card, so only an https partiful.com
// event link is accepted — never an arbitrary URL from the device.
function shareLink(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'partiful.com') return null;
  return url.toString();
}

function platformOf(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  if (!source.startsWith(PARTIFUL.sourcePrefix)) return null;
  const platform = source.slice(PARTIFUL.sourcePrefix.length);
  return PARTIFUL.platforms.has(platform) ? platform : null;
}

function isPartifulReport(body) {
  return Boolean(body) && platformOf(body) !== null && body.service === PARTIFUL.service;
}

/**
 * Reduce a client report to the bounded facts the alert and prompt use.
 * Returns null when the required facts (event, known reason code) are
 * missing or malformed.
 */
function normalizeReport(body) {
  if (!body || typeof body !== 'object') return null;
  const platform = platformOf(body);
  const eventId = typeof body.eventId === 'string' && SLUG_RE.test(body.eventId) ? body.eventId : null;
  const reason = typeof body.reason === 'string' && Object.hasOwn(REASONS, body.reason) ? body.reason : null;
  if (!platform || !eventId || !reason) return null;

  const release = typeof body.release === 'string' && RELEASE_RE.test(body.release)
    ? body.release
    : `${PARTIFUL.service}@unknown`;

  return {
    platform,
    platformLabel: PLATFORM_LABELS[platform],
    release,
    eventId,
    reason,
    eventTitle: clip(body.eventTitle, 80),
    host: clip(body.host, 60),
    theme: clip(body.theme, 24),
    screen: typeof body.screen === 'string' && TOKEN_RE.test(body.screen) ? body.screen : 'event',
    action: typeof body.action === 'string' && TOKEN_RE.test(body.action) ? body.action : 'open_rsvp_page',
    invitedCount: count(body.invitedCount),
    goingCount: count(body.goingCount),
    shareLink: shareLink(body.shareLink),
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
    logger.warn('Partiful triggered-by Slack lookup failed', { error: error.message });
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

function monitorName(report) {
  return REASONS[report.reason].monitor;
}

function symptomOf(report) {
  return REASONS[report.reason].symptom;
}

function monitorTitle(report) {
  return `${monitorName(report)} — ${PARTIFUL.service} (${report.platformLabel})`;
}

function eventLine(report) {
  const parts = [report.eventTitle || report.eventId];
  if (report.host) parts.push(`host ${report.host}`);
  if (report.theme) parts.push(`${report.theme} theme`);
  parts.push(`\`${report.eventId}\``);
  return parts.join(' · ');
}

function guestLine(report) {
  if (report.invitedCount === null && report.goingCount === null) return '';
  const invited = report.invitedCount === null ? '?' : report.invitedCount;
  const going = report.goingCount === null ? '?' : report.goingCount;
  return `${invited} invited · ${going} going — none of them can RSVP`;
}

/**
 * Alert card. Every fact on it came from the device that failed; the
 * only synthetic element is the on-call persona, labelled as such.
 */
function buildAlertMessage(report, { reference, triggeredBy, now }) {
  const lines = [
    `:rotating_light: *[Triggered] ${monitorTitle(report)}*`,
    '',
    `*Service:* ${PARTIFUL.service} (${PARTIFUL.brand})`,
    `*Check:* \`${PARTIFUL.check}\` — failed on device (reason: \`${report.reason}\`)`,
    `*Where:* ${report.screen} → ${report.action}`,
    `*Event:* ${eventLine(report)}`,
    guestLine(report) ? `*Guests:* ${guestLine(report)}` : null,
    report.shareLink ? `*Invite link:* ${report.shareLink}` : null,
    `*Owner:* ${PARTIFUL.owner} — ${OWNER_DISCLAIMER}`,
    `*Incident Ref:* ${reference}`,
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
    '',
    `Env: production | Release: ${report.release} | Platform: ${report.platformLabel}`,
    `Reported: ${now.toISOString()}`,
    '',
    `*Symptom:* ${symptomOf(report)}`,
    `*Impact:* ${PARTIFUL.impact}`,
    `Repo: ${PARTIFUL.repo} (${PARTIFUL.appDir})`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function buildAlertBlocks(report, { reference, triggeredBy, now }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${monitorTitle(report)}`, emoji: true } },
    ...fieldPairs([
      ['Service', `${PARTIFUL.service} (${PARTIFUL.brand})`],
      ['Where', `${report.screen} → ${report.action}`],
      ['Event', eventLine(report)],
      ['Guests', guestLine(report)],
      ['Invite link', report.shareLink],
      ['Release', `${report.release} (${report.platformLabel})`],
      ['Owner', `${PARTIFUL.owner} — ${OWNER_DISCLAIMER}`],
      ['Incident Ref', reference],
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    { type: 'section', text: { type: 'mrkdwn', text: `*Check:*\n\`\`\`${PARTIFUL.check} — failed on device (reason: ${report.reason})\`\`\`` } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Symptom:* ${symptomOf(report)}\n*Impact:* ${PARTIFUL.impact}\nRepo: ${PARTIFUL.repo} (${PARTIFUL.appDir})`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `Service: \`${PARTIFUL.service}\``,
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
    `A customer-visible defect was reported by the ${PARTIFUL.brand} app — a native SwiftUI iOS/macOS app. Investigate it and open a PR with the fix.`,
    '',
    `*Alert:* ${monitorTitle(report)} — Triggered`,
    `*Incident Ref:* ${reference}`,
    `*Check:* \`${PARTIFUL.check}\` failed on device (reason: \`${report.reason}\`)`,
    `*Where:* ${report.screen} → ${report.action}`,
    `*Event:* ${eventLine(report)}`,
    guestLine(report) ? `*Guests:* ${guestLine(report)}` : null,
    `*Release:* ${report.release} (${report.platformLabel})`,
    `*Symptom:* ${symptomOf(report)}`,
    `*Impact:* ${PARTIFUL.impact}`,
    '',
    `Repository: ${PARTIFUL.repo} — the app is ${PARTIFUL.appDir} (read its DEMO.md and the repo Makefile first).`,
    `Reproduce it on this macOS machine: \`APP=${PARTIFUL.slug} make run\` (iOS Simulator) or \`APP=${PARTIFUL.slug} make run-mac\` (native macOS), then open the event \`${report.eventId}\` from the party list.`,
    `Run the tests serially with \`APP=${PARTIFUL.slug} make test\` — never start a second xcodebuild while one is running, and interrupt any xcodebuild that exceeds three minutes.`,
    'Find the root cause, add a regression test that fails before and passes after, prove the fix with a before/after screen recording on the Simulator, and open a fix PR against main. Do not merge or deploy anything: the PR is the end state and a human reviews it.',
  ].filter((l) => l !== null).join('\n');
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
    logger.warn('Partiful Devin session creation throttled', { reference, ...cap });
    return null;
  }

  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildSessionPrompt(report, reference), {
      ...resolveSessionIdentity(),
      title: `[On-Call] ${reference} ${monitorName(report)} (${PARTIFUL.service})`,
      platform: SESSION_PLATFORM(),
      repos: [PARTIFUL.repoName],
    });
  } catch (error) {
    logger.error('Partiful Devin session failed', { reference, error: error.message });
  }

  if (!session) {
    release();
    return null;
  }

  logger.info('Partiful Devin session created', { reference, sessionId: session.sessionId });

  if (token && channel && threadTs) {
    try {
      await postThreadReply(token, channel, threadTs, `Devin is investigating: ${session.url}`, [
        { type: 'section', text: { type: 'mrkdwn', text: `:mag: *Devin is investigating this alert* — <${session.url}|View session> (macOS, ${PARTIFUL.repoName})` } },
      ]);
    } catch (error) {
      logger.error('Partiful session link reply failed', { reference, error: error.message });
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
function reportRsvpPageFailure(report) {
  if (!report || !report.platform || !report.eventId || !report.reason) return null;

  pruneReports();
  const reference = makeReference();
  const statusToken = makeStatusToken();
  const now = new Date();
  const entry = {
    reference,
    statusToken,
    receivedAt: now.getTime(),
    platform: report.platform,
    eventId: report.eventId,
    alert: null,
    session: null,
    error: null,
    done: false,
  };
  reports.set(reference, entry);

  const tags = {
    route: `/api/oncall/${PARTIFUL.slug}/rsvp-page-failure`,
    service: PARTIFUL.service,
    check: PARTIFUL.check,
    platform: report.platform,
    screen: report.screen,
    action: report.action,
    reason: report.reason,
  };
  incrementMetric('partiful_rsvp.page_failure', { route: tags.route, platform: report.platform, reason: report.reason });
  logger.error('Partiful RSVP page failure reported', {
    reference,
    platform: report.platform,
    release: report.release,
    eventId: report.eventId,
    reason: report.reason,
    invitedCount: report.invitedCount,
    goingCount: report.goingCount,
  });
  // Tagged with the on-call route, so the Sentry webhook's on-call-slice
  // filter never raises a second alert or session for this event.
  Sentry.captureMessage(`${monitorName(report)} (${PARTIFUL.service}/${report.platform})`, {
    level: 'error',
    tags,
    extra: {
      reference,
      release: report.release,
      eventId: report.eventId,
      reason: report.reason,
      invitedCount: report.invitedCount,
      goingCount: report.goingCount,
    },
  });

  const outcome = (async () => {
    try {
      const { token, alertsChannel } = resolveOncallEnv();
      let alertTs = null;
      if (!token || !alertsChannel) {
        entry.error = 'alerts channel not configured';
        logger.warn('On-Call alerts channel not configured — Partiful alert not posted', { reference });
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
          logger.info('Partiful On-Call alert posted', { reference, channel: alertsChannel, ts: alertTs });
        } catch (error) {
          entry.error = 'alert failed';
          logger.error('Partiful On-Call alert failed', { reference, error: error.message });
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
      logger.error('Partiful RSVP failure pipeline failed', { reference, error: error.message });
    } finally {
      entry.done = true;
    }
    return entry;
  })();

  return { reference, statusToken, outcome };
}

/**
 * Outcome of a report, for the app's status poll. The reference is short
 * enough to read off an alert card, so it is not a secret: callers must
 * also present the statusToken the 202 response handed to the reporting
 * device.
 */
function getRsvpPageFailureStatus(reference, statusToken) {
  if (typeof reference !== 'string' || !REFERENCE_RE.test(reference)) return null;
  pruneReports();
  const entry = reports.get(reference);
  if (!entry || !tokenMatches(entry.statusToken, statusToken)) return null;
  return {
    reference: entry.reference,
    service: PARTIFUL.service,
    alertPosted: Boolean(entry.alert),
    sessionUrl: entry.session ? entry.session.url : null,
    done: entry.done,
    error: entry.error,
  };
}

module.exports = {
  PARTIFUL,
  REASONS,
  isPartifulReport,
  normalizeReport,
  buildAlertMessage,
  buildAlertBlocks,
  buildSessionPrompt,
  reportRsvpPageFailure,
  getRsvpPageFailureStatus,
};
