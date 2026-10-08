const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');
const { incrementMetric } = require('../../telemetry/datadog');
const { postMessage, postThreadReply, lookupSlackUserByEmail } = require('../slack');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');

/**
 * CommBank account-opening (6c2cc636) — online ID check rejections reported
 * by the native SwiftUI account-opening demo in COG-GTM/ios-demos
 * (apps/6c2cc636, iOS + macOS, no telemetry SDK).
 *
 * When the app's "We'll need to check your ID" screen rejects the selected
 * document on Agree & Continue, the app POSTs bounded facts — document kind,
 * issuing country, linked-visa facts, reason code, applicant age — to
 * /api/oncall/6c2cc636/id-check-failure. This module owns everything the
 * app must not: the Slack token, the alert copy and the dedup map.
 *
 * Like Fleet and Partiful, it posts one alert card to the On-Call alerts
 * channel, creates one Devin session on a macOS machine (the app only
 * builds with Xcode) and links the session in the alert thread. The
 * `#oncall-alerts` responder automation skips the card because the
 * fallback text carries the `account-opening` token.
 *
 * Only bounded scalar facts are accepted from the client; anything else
 * is dropped, and no client string reaches the card unvalidated.
 */

const ACCOUNT_OPENING = {
  slug: '6c2cc636',
  brand: 'CommBank',
  service: 'account-opening',
  check: 'online_id_check',
  repo: 'COG-GTM/ios-demos',
  appDir: 'apps/6c2cc636',
};

const REPO_URL = `https://github.com/${ACCOUNT_OPENING.repo}`;
const ROUTE = `/api/oncall/${ACCOUNT_OPENING.slug}/id-check-failure`;

const SOURCE_PREFIX = 'account-opening/';
const PLATFORM_LABELS = { ios: 'iOS', macos: 'macOS' };

// Devin platform label the investigation runs on. The app is native
// SwiftUI: only a macOS machine with Xcode can build and reproduce it.
const SESSION_PLATFORM = () => process.env.DEVIN_ONCALL_ACCOUNT_OPENING_PLATFORM || 'macos';

const REASONS = new Set(['document_expired', 'visa_missing', 'visa_not_eligible', 'visa_expired']);
const DOCUMENT_KINDS = new Set(['passport', 'driver_licence', 'medicare_card', 'birth_certificate']);

const REFERENCE_RE = /^CBA-[0-9a-f]{6}$/;
const ISSUING_COUNTRY_RE = /^[A-Z]{3}$/;
const EMAIL_RE = /^[^\s@<>|]{1,64}@[^\s@<>|]{1,255}$/;
const SHORT_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,63}$/;

const IMPACT = 'New customers cannot finish opening an account in the app';

// Dedup map: a retried report with the same reference is acknowledged
// without redoing finished work. Each entry is
// { receivedAt, inFlight, alert, session, threadLinked }; a reference
// counts as known while a delivery is in flight or once the alert, the
// session and the thread link all exist, so a retry re-attempts only
// the missing piece. In-memory, bounded, 6h TTL.
const REPORT_TTL_MS = 6 * 60 * 60 * 1000;
const REPORT_MAX = 200;
const reports = new Map();

function pruneReports() {
  const cutoff = Date.now() - REPORT_TTL_MS;
  for (const [reference, entry] of reports) {
    if (entry.receivedAt < cutoff) reports.delete(reference);
  }
}

function isComplete(entry) {
  return Boolean(entry) && Boolean(entry.alert && entry.session && entry.threadLinked);
}

function isKnownReference(reference) {
  pruneReports();
  const entry = reports.get(reference);
  return Boolean(entry) && (entry.inFlight || isComplete(entry));
}

// True for any cached reference, including an incomplete one a retry
// should resume; the route uses this to skip the shared trigger cap.
function hasReference(reference) {
  pruneReports();
  return reports.has(reference);
}

function makeReference() {
  let reference;
  do {
    reference = `CBA-${crypto.randomBytes(3).toString('hex')}`;
  } while (reports.has(reference));
  return reference;
}

function clippedToken(value, fallback) {
  return typeof value === 'string' && SHORT_TOKEN_RE.test(value) ? value : fallback;
}

function platformOf(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  if (!source.startsWith(SOURCE_PREFIX)) return null;
  const platform = source.slice(SOURCE_PREFIX.length);
  return Object.hasOwn(PLATFORM_LABELS, platform) ? platform : null;
}

function isAccountOpeningReport(body) {
  return Boolean(body) && platformOf(body) !== null && body.service === ACCOUNT_OPENING.service;
}

/**
 * Reduce a client report to the bounded facts the alert card uses.
 * Returns null when a required fact is missing or malformed — a 400.
 * Unknown fields are dropped entirely.
 */
function normalizeReport(body) {
  if (!body || typeof body !== 'object') return null;
  const platform = platformOf(body);
  if (!platform) return null;

  const reason = typeof body.reason === 'string' && REASONS.has(body.reason) ? body.reason : null;
  const issuingCountry = typeof body.issuingCountry === 'string' && ISSUING_COUNTRY_RE.test(body.issuingCountry)
    ? body.issuingCountry
    : null;
  const documentKind = typeof body.documentKind === 'string' && DOCUMENT_KINDS.has(body.documentKind)
    ? body.documentKind
    : null;
  const visaSubclass = body.visaSubclass === null
    ? null
    : (Number.isInteger(body.visaSubclass) && body.visaSubclass >= 100 && body.visaSubclass <= 999
        ? body.visaSubclass
        : undefined);
  const hasLinkedVisa = typeof body.hasLinkedVisa === 'boolean' ? body.hasLinkedVisa : null;
  const applicantAge = Number.isInteger(body.applicantAge) && body.applicantAge >= 0 && body.applicantAge <= 130
    ? body.applicantAge
    : null;

  if (!reason || !issuingCountry || !documentKind || visaSubclass === undefined || hasLinkedVisa === null || applicantAge === null) {
    return null;
  }

  return {
    platform,
    platformLabel: PLATFORM_LABELS[platform],
    reason,
    issuingCountry,
    documentKind,
    visaSubclass,
    hasLinkedVisa,
    applicantAge,
    reference: typeof body.reference === 'string' && REFERENCE_RE.test(body.reference) ? body.reference : null,
    release: clippedToken(body.release, `${ACCOUNT_OPENING.service}@unknown`),
    screen: clippedToken(body.screen, 'choose_id'),
    action: clippedToken(body.action, 'agree_continue'),
    customerType: clippedToken(body.customerType, 'new_to_bank'),
    product: clippedToken(body.product, 'smart_access'),
    osVersion: clippedToken(body.osVersion, ''),
    appVersion: clippedToken(body.appVersion, ''),
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
    logger.warn('Account-opening triggered-by Slack lookup failed', { error: error.message });
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

const DOCUMENT_LABELS = {
  passport: 'a passport',
  driver_licence: 'a driver licence',
  medicare_card: 'a Medicare card',
  birth_certificate: 'a birth certificate',
};
const DOCUMENT_NOUNS = {
  passport: 'passport',
  driver_licence: 'driver licence',
  medicare_card: 'Medicare card',
  birth_certificate: 'birth certificate',
};

function monitorTitle(report) {
  const label = DOCUMENT_LABELS[report.documentKind] || 'a document';
  return `Online ID check rejected ${label} (${ACCOUNT_OPENING.service}/${report.platform})`;
}

function symptomLine(report) {
  const noun = DOCUMENT_NOUNS[report.documentKind] || 'document';
  return `Applicant sees: We're unable to accept this ${noun}`;
}

function documentLine(report) {
  const visa = report.hasLinkedVisa
    ? `linked visa yes (subclass ${report.visaSubclass ?? '?'})`
    : 'linked visa no';
  return `${report.documentKind} · issuing country ${report.issuingCountry} · ${visa}`;
}

function applicantLine(report) {
  return `${report.customerType} · age ${report.applicantAge} · product ${report.product}`;
}

function buildAlertMessage(report, { reference, triggeredBy, now }) {
  const lines = [
    `:rotating_light: *[Triggered] ${monitorTitle(report)}*`,
    '',
    `*Service:* ${ACCOUNT_OPENING.service} (${ACCOUNT_OPENING.brand})`,
    `*Incident Ref:* ${reference}`,
    `*Check:* \`${ACCOUNT_OPENING.check}\` — failed on device (reason: \`${report.reason}\`)`,
    `*Where:* ${report.screen} → ${report.action}`,
    `*Document:* ${documentLine(report)}`,
    `*Applicant:* ${applicantLine(report)}`,
    `*Release:* ${report.release} (${report.platformLabel})`,
    '*Owner:* onboarding-oncall',
    triggeredBy ? `*Triggered by:* ${triggeredBy}` : null,
    '',
    `Reported: ${now.toISOString()}`,
    '',
    `*Symptom:* ${symptomLine(report)}`,
    `*Impact:* ${IMPACT}`,
    `Repo: ${REPO_URL} (${ACCOUNT_OPENING.appDir})`,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function buildAlertBlocks(report, { reference, triggeredBy, now }) {
  return [
    { type: 'header', text: { type: 'plain_text', text: `:rotating_light: [Triggered] ${monitorTitle(report)}`, emoji: true } },
    ...fieldPairs([
      ['Service', `${ACCOUNT_OPENING.service} (${ACCOUNT_OPENING.brand})`],
      ['Incident Ref', reference],
      ['Check', `\`${ACCOUNT_OPENING.check}\` (reason \`${report.reason}\`)`],
      ['Where', `${report.screen} → ${report.action}`],
      ['Document', documentLine(report)],
      ['Applicant', applicantLine(report)],
      ['Release', `${report.release} (${report.platformLabel})`],
      ['Owner', 'onboarding-oncall'],
      triggeredBy ? ['Triggered by', triggeredBy] : null,
    ]),
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Symptom:* ${symptomLine(report)}\n*Impact:* ${IMPACT}\nRepo: ${REPO_URL} (${ACCOUNT_OPENING.appDir})`,
      },
    },
    {
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: [
          `Service: \`${ACCOUNT_OPENING.service}\``,
          `Reported from the ${report.platformLabel} app`,
          now.toISOString(),
          triggeredBy ? `Triggered by ${triggeredBy}` : null,
        ].filter(Boolean).join(' | '),
      }],
    },
  ];
}

/**
 * Investigation prompt. Built from the same bounded facts the alert shows
 * plus the build/verify instructions for the app — no code locations, so the
 * session finds the cause by reproducing it. Never includes applicant name,
 * passport number or date of birth (the server never receives them).
 */
function buildSessionPrompt(report, reference, alert) {
  const app = ACCOUNT_OPENING.slug;
  const appPath = `apps/${app}`;
  const lines = [
    `A customer-visible defect was reported by the ${ACCOUNT_OPENING.brand} account-opening app — a native SwiftUI iOS/macOS app. Investigate it and open a PR with the fix.`,
    '',
    `*Alert:* ${monitorTitle(report)} — Triggered`,
    `*Incident Ref:* ${reference}`,
    `*Check:* \`${ACCOUNT_OPENING.check}\` failed on device (reason: \`${report.reason}\`)`,
    `*Where:* ${report.screen} → ${report.action}`,
    `*Document:* ${documentLine(report)}`,
    `*Applicant:* ${applicantLine(report)}`,
    `*Release:* ${report.release} (${report.platformLabel})`,
    `*Symptom:* ${symptomLine(report)}`,
    `*Impact:* ${IMPACT}`,
    '',
    `Repository: ${REPO_URL} — the app is ${appPath} (read its DEMO.md and the repo Makefile first).`,
    'Reproduce it on this macOS machine with failure reporting OFF. Every report the app sends raises a new alert and a new Devin session, so never launch the app with reporting on (do not use `make run` or `make run-mac`, which launch without the switch):',
    `- iOS Simulator: boot an iPhone simulator, then \`APP=${app} SIM_UDID=<udid> make build\`, \`xcrun simctl install <udid> ${appPath}/build/Build/Products/Debug-iphonesimulator/Demo${app}.app\` and \`xcrun simctl launch <udid> com.demo.${app} -onboarding.disableFailureReports YES\`.`,
    `- Native macOS: \`APP=${app} make build-mac\`, then \`open ${appPath}/build-mac/Build/Products/Debug/Demo${app}.app --args -onboarding.disableFailureReports YES\`.`,
    'Then Welcome → Sign up → New to CommBank → Smart Access → Open now → Next → Accept → Check your ID, keep the passport on file selected and tap Agree & Continue.',
    `Run the tests serially with \`APP=${app} SIM_UDID=<udid> make test\` — never start a second xcodebuild while one is running, and interrupt any xcodebuild that exceeds three minutes.`,
    'Find the root cause, add a regression test that fails before and passes after, prove the fix with a before/after screen recording on the Simulator and the macOS app, and open a **draft** PR against main titled with a `[DEMO — DO NOT MERGE]` prefix and request Devin Review. Never merge it and do not deploy anything: the planted defect on main is kept for future demos.',
  ];
  if (alert) {
    lines.push(
      '',
      `*Slack Thread:* channel=${alert.channel} thread_ts=${alert.ts}`,
      'When the fix PR is open, reply once in that Slack thread (thread_ts above, not the channel) using the Slack integration available in this session: the root cause in one or two plain sentences, the regression test you added, and the fix PR link. Never include the applicant\'s name, date of birth or passport number.',
    );
  }
  return lines.join('\n');
}

function resolveSessionIdentity() {
  return {
    orgId: process.env.DEVIN_ONCALL_ORG_ID || process.env.DEVIN_ORG_ID,
    userId: process.env.DEVIN_ONCALL_USER_ID || null,
    apiKey: process.env.DEVIN_ONCALL_SERVICE_KEY,
  };
}

/**
 * Reply in the alert thread linking the Devin session — always on the
 * channel and timestamp the alert was posted to, never the current env
 * channel. Returns true on success, false on failure; never throws.
 */
async function linkSessionInThread(token, channel, threadTs, sessionUrl) {
  try {
    await postThreadReply(token, channel, threadTs, `Devin is investigating: ${sessionUrl}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `:mag: *Devin is investigating this alert* — <${sessionUrl}|View session> (macOS, COG-GTM/ios-demos)` } },
    ]);
    return true;
  } catch (error) {
    logger.error('Account-opening session link reply failed', { sessionUrl, error: error.message });
    return false;
  }
}

/**
 * Create the investigation session. Never throws: a failed session must
 * not fail the alert that triggered it. The thread link is a separate
 * step in `deliver`, so a reply failure does not strand the session.
 */
async function triggerDevinSession(report, reference, alert) {
  const cap = canCreateSession();
  if (!cap.allowed) {
    logger.warn('Account-opening Devin session creation throttled', { reference, ...cap });
    return null;
  }

  const release = reserveSession();
  let session = null;
  try {
    session = await createDevinSession(buildSessionPrompt(report, reference, alert), {
      ...resolveSessionIdentity(),
      title: `[On-Call] ${reference} ${monitorTitle(report)}`,
      platform: SESSION_PLATFORM(),
      repos: [ACCOUNT_OPENING.repo],
    });
  } catch (error) {
    logger.error('Account-opening Devin session failed', { reference, error: error.message });
  }

  if (!session) {
    release();
    return null;
  }

  logger.info('Account-opening Devin session created', { reference, sessionId: session.sessionId });
  return session;
}

/**
 * Deliver the pending pieces of a report: the alert card if none exists,
 * then the Devin session if none exists — even when the alert failed,
 * like Fleet — then the thread reply linking the session in the alert's
 * thread, always on the channel and ts the alert was posted to. Each
 * piece is its own step, so a retry of an incomplete reference
 * re-attempts only what is missing: a failed reply never strands the
 * session link, and no session is created twice. Never throws; always
 * clears `inFlight` so a later retry can proceed.
 */
async function deliver(report, reference, now) {
  const entry = reports.get(reference);
  const outcome = { reference, duplicate: false, alert: null, session: null, error: null };
  if (!entry) {
    outcome.error = 'report evicted';
    return outcome;
  }
  try {
    const { token, alertsChannel } = resolveOncallEnv();

    if (!entry.alert) {
      if (!token || !alertsChannel) {
        outcome.error = 'alerts channel not configured';
        logger.warn('On-Call alerts channel not configured — account-opening alert not posted', { reference });
      } else {
        const triggeredBy = await resolveTriggeredBy(token, report.devinEmail);
        try {
          const alertTs = await postMessage(
            token,
            alertsChannel,
            buildAlertMessage(report, { reference, triggeredBy, now }),
            buildAlertBlocks(report, { reference, triggeredBy, now }),
          );
          entry.alert = { channel: alertsChannel, ts: alertTs };
          logger.info('Account-opening On-Call alert posted', { reference, channel: alertsChannel, ts: alertTs });
        } catch (error) {
          outcome.error = 'alert failed';
          logger.error('Account-opening On-Call alert failed', { reference, error: error.message });
        }
      }
    }

    if (!entry.session) {
      const session = await triggerDevinSession(report, reference, entry.alert);
      if (session) {
        entry.session = { id: session.sessionId, url: session.url };
      } else if (!outcome.error) {
        outcome.error = 'session not created';
      }
    }

    if (entry.alert && entry.session && !entry.threadLinked && token) {
      entry.threadLinked = await linkSessionInThread(
        token,
        entry.alert.channel,
        entry.alert.ts,
        entry.session.url,
      );
      if (!entry.threadLinked && !outcome.error) {
        outcome.error = 'session link failed';
      }
    }
  } catch (error) {
    outcome.error = 'pipeline failed';
    logger.error('Account-opening ID-check pipeline failed', { reference, error: error.message });
  } finally {
    entry.inFlight = false;
    outcome.alert = entry.alert;
    outcome.session = entry.session;
  }
  return outcome;
}

/**
 * Handle a normalized ID-check rejection: record it, emit the metric and
 * Sentry event, post the alert card and create one Devin session. A retry
 * of a reference whose delivery is incomplete re-attempts only the
 * missing piece — the metric, log and Sentry event are not emitted twice.
 * Returns the reference synchronously; the Slack/Devin work continues in
 * `outcome`, which never throws — missing channel/token records `error`
 * and still lets the route answer 202.
 */
function reportIdCheckFailure(report) {
  if (!report || !report.platform || !report.reason) return null;

  const clientReference = report.reference;
  const reference = clientReference && REFERENCE_RE.test(clientReference) ? clientReference : makeReference();

  pruneReports();
  const existing = reports.get(reference);
  if (existing) {
    if (existing.inFlight || isComplete(existing)) {
      return { reference, duplicate: true, outcome: Promise.resolve({ reference, duplicate: true, error: null }) };
    }
    existing.inFlight = true;
    return { reference, outcome: deliver(report, reference, new Date()) };
  }
  reports.set(reference, { receivedAt: Date.now(), inFlight: true, alert: null, session: null, threadLinked: false });
  while (reports.size > REPORT_MAX) {
    reports.delete(reports.keys().next().value);
  }

  const now = new Date();
  const tags = {
    route: ROUTE,
    service: ACCOUNT_OPENING.service,
    check: ACCOUNT_OPENING.check,
    platform: report.platform,
    screen: report.screen,
    action: report.action,
    reason: report.reason,
  };
  incrementMetric('account_opening.id_check_failure', { route: ROUTE, platform: report.platform, reason: report.reason });
  logger.error('Account-opening ID check failure reported', {
    reference,
    platform: report.platform,
    release: report.release,
    documentKind: report.documentKind,
    issuingCountry: report.issuingCountry,
    hasLinkedVisa: report.hasLinkedVisa,
    visaSubclass: report.visaSubclass,
    reason: report.reason,
  });
  // Tagged with the on-call route, so the Sentry webhook's on-call-slice
  // filter never raises a second session for this event.
  Sentry.captureMessage(`${monitorTitle(report)}`, {
    level: 'error',
    tags,
    extra: {
      reference,
      release: report.release,
      documentKind: report.documentKind,
      issuingCountry: report.issuingCountry,
      reason: report.reason,
    },
  });

  return { reference, outcome: deliver(report, reference, now) };
}

module.exports = {
  ACCOUNT_OPENING,
  isAccountOpeningReport,
  isKnownReference,
  hasReference,
  normalizeReport,
  buildAlertMessage,
  buildAlertBlocks,
  buildSessionPrompt,
  reportIdCheckFailure,
};
