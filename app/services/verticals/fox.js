const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { createSessionAndAlert } = require('../devin-session');

/**
 * FOX live channels available in the tvOS app. `market` selects which
 * regional playback-token signer must vouch for the viewer's entitlement
 * before a live manifest URL is handed out.
 */
const CHANNELS = {
  fox: { label: 'FOX', callSign: 'KTTV', market: 'west', requiresTvProvider: true },
  'fox-news': { label: 'FOX News', callSign: 'FNC', market: 'national', requiresTvProvider: true },
  'fox-business': { label: 'FOX Business', callSign: 'FBN', market: 'national', requiresTvProvider: true },
  fs1: { label: 'FS1', callSign: 'FS1', market: 'national', requiresTvProvider: true },
  fs2: { label: 'FS2', callSign: 'FS2', market: 'national', requiresTvProvider: true },
  'fox-weather': { label: 'FOX Weather', callSign: 'FXW', market: 'national', requiresTvProvider: false },
};

/**
 * Playback-token signers by market. Every `market` referenced by a channel
 * must resolve to an active signer here before an entitlement can be issued.
 */
const TOKEN_SIGNERS = {
  national: { id: 'fox-ent-signer-01', endpoint: 'ent-national.fox.internal', active: true },
  east: { id: 'fox-ent-signer-02', endpoint: 'ent-east.fox.internal', active: true },
  central: { id: 'fox-ent-signer-03', endpoint: 'ent-central.fox.internal', active: true },
};

/**
 * Demo viewer profiles returned by the (stubbed) TV-provider directory.
 */
const VIEWERS = {
  'FOX-7731-2290': { name: 'Yubin Jee', provider: 'Spectrum', zip: '90028' },
  'FOX-1042-8816': { name: 'Jordan Reyes', provider: 'Xfinity', zip: '10001' },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the
 * repositories involved and the expected remediation have to be named here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repositories:*',
  '- Backend (source of the 500): `COG-GTM/event-driven-devin`',
  '  - Service: `app/services/verticals/fox.js`',
  '  - Route: `app/routes/verticals/fox.js` (`POST /api/fox/live/entitlement`)',
  '- tvOS client: `COG-GTM/fox-tvos` (Swift / SwiftUI, Apple TV)',
  '  - Watch Live flow: `FoxTV/Views/WatchLiveView.swift`',
  '  - View model: `FoxTV/ViewModels/WatchLiveViewModel.swift`',
  '  - API client: `FoxTV/Networking/FoxApi.swift`',
  '',
  '*Scope:* Diagnose the backend failure, but do NOT change the backend — the live',
  'entitlement service is owned by another team. Fix the tvOS client instead: it currently',
  'renders the raw error type, message, and stack trace on the television. Replace that with',
  'a consumer-grade error state a viewer would see in the real FOX app: one short sentence in',
  "FOX's own voice saying what happened and what they can do next, a *Try Again* action, and a",
  '*Back to Guide* action.',
  '',
  '*What the screen must NOT show:* no exception or error type, no stack trace, no HTTP status,',
  'none of the backend `error` / `message` / `code` fields, no request or trace ID, and no',
  '"support details" / "technical details" block — collapsed, behind a button, or otherwise.',
  'A viewer must not be able to tell an entitlement outage from a network timeout. Keep those',
  'fields in `os_log` only. Referencing any of them anywhere on screen fails the deliverable.',
  'Acceptable copy, for example: "We couldn\'t start FOX live right now. Please try again in a',
  'moment, or pick another channel from the guide."',
  '',
  '*Deliverable:* Open a pull request against `main` in `COG-GTM/fox-tvos`, with a single',
  'screen recording of the Apple TV simulator attached that shows the before and after in',
  'one take:',
  '1. *Before* — the unfixed app: open Live TV, select FOX, choose *Watch Live*, and let the',
  '   raw error / stack trace stay on screen long enough to read.',
  '2. *Fix* — apply your change and rebuild/reinstall the app from the command line.',
  '3. *After* — repeat the same steps and hold on the graceful error state long enough to',
  '   confirm no codes, IDs, or technical detail appear anywhere.',
  'The recording is the proof the fix is real, so do not skip the before segment and do',
  'not substitute screenshots for a live run.',
  '',
  '*Verification target:* run this repo locally (`npm ci`, `PORT=3000 node app/server.js`)',
  'and build the app against it with the default base URL `http://127.0.0.1:3000` (the',
  'simulator shares the Mac\'s loopback), which reproduces the same 500. Never point the app',
  'at the deployed backend, and never set `FOX_DEMO_TOKEN` in the xcconfig or build',
  'settings: that token is the presenter build\'s, and sending it turns a verification',
  'attempt into a production page.',
].join('\n');

/**
 * Free-text fields flow into Slack alert cards and the Devin investigation
 * prompt, so callers must not be able to smuggle markup or instructions in.
 */
function sanitizeText(value, maxLength = 80) {
  return String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[`*_~<>|@#\\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Owner shown on the FOX alert card. The tvOS client is unauthenticated,
 * so the demo owner is fixed here rather than taken from the request.
 */
const OWNER_EMAIL = 'yubin.jee@cognition.ai';

/**
 * Kill switch. The deployment has no FOX-specific host configuration, so this
 * is a code constant — flipping it is a merge. False keeps the intentional 500
 * and drops the Slack card and the Devin session.
 */
const alerting = { enabled: true };

/**
 * Only the presenter's build alerts. The tvOS client sends this token when it
 * is built with `FOX_DEMO_TOKEN` set in its xcconfig, which the default build a
 * triggered session produces does not set — so a session that reaches the
 * deployed endpoint while verifying its fix gets the intentional 500 and
 * nothing else, instead of paging and spawning another session. The value is
 * not a secret: the guard works because triggered builds send no token at all.
 */
const DEMO_TOKEN = 'fox-presenter-demo';

/**
 * The token is the loop guard, so presenter taps are deliberately unthrottled:
 * every Watch Live from the demo build pages, and nothing else can.
 */
function alertBlockReason(demoToken) {
  if (!alerting.enabled) return 'FOX alerting is switched off';
  if (String(demoToken || '') !== DEMO_TOKEN) {
    return 'request did not carry the presenter demo token';
  }
  return null;
}

/**
 * The entitlement endpoint is unauthenticated, so a Devin identity in the
 * request body is never honoured — sessions are always created as the
 * customer's configured identity.
 */
function resolveDevinIdentity(data) {
  const requestedOrgId = String(data.devinOrgId || '').trim();

  if (requestedOrgId) {
    logger.warn('Ignoring caller-supplied Devin identity for FOX live entitlement', {
      requestedOrgId,
      service: 'customer-fox-live-entitlement',
    });
  }

  return { devinOrgId: undefined, devinUserId: undefined, devinEmail: OWNER_EMAIL };
}

function findViewer(profileId) {
  const key = String(profileId || '').trim().toUpperCase();
  const viewer = VIEWERS[key];
  if (!viewer) {
    const error = new Error('TV provider profile not found.');
    error.name = 'ViewerProfileNotFound';
    error.code = 'VIEWER_PROFILE_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return viewer;
}

function findChannel(channelId) {
  const channel = CHANNELS[String(channelId || '').trim().toLowerCase()];
  if (!channel) {
    const error = new Error('Channel is not in the live lineup.');
    error.name = 'ChannelNotFound';
    error.code = 'CHANNEL_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return channel;
}

/**
 * Resolve the playback-token signer that vouches for this channel's market.
 */
function resolveTokenSigner(channel) {
  const signer = TOKEN_SIGNERS[channel.market];
  if (!signer || !signer.active) {
    const signerId = signer ? signer.id : `fox-ent-signer-${channel.market}`;
    const error = new Error(
      `Live stream entitlement service is unavailable: playback token signer ${signerId} for market ${channel.market.toUpperCase()} (${channel.callSign}) is not registered`,
    );
    error.name = 'StreamEntitlementUnavailable';
    error.code = 'STREAM_ENTITLEMENT_UNAVAILABLE';
    error.statusCode = 500;
    throw error;
  }
  return signer;
}

/**
 * Sign a short-lived playback token for the viewer and return the manifest.
 */
function issueEntitlement(viewer, channel) {
  const signer = resolveTokenSigner(channel);
  if (channel.requiresTvProvider && !viewer.provider) {
    const error = new Error('A TV provider sign-in is required to watch this channel.');
    error.name = 'TvProviderRequired';
    error.code = 'TV_PROVIDER_REQUIRED';
    error.statusCode = 403;
    throw error;
  }
  return {
    signer: signer.id,
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    manifestUrl: `https://live.fox.internal/${channel.callSign.toLowerCase()}/master.m3u8`,
  };
}

function buildPlaybackSession(sessionId, viewer, channel, data, entitlement) {
  return {
    sessionId,
    status: 'entitled',
    viewer: { name: viewer.name, provider: viewer.provider },
    channel: { id: data.channelId, label: channel.label, callSign: channel.callSign },
    device: data.device,
    manifestUrl: entitlement.manifestUrl,
    expiresAt: entitlement.expiresAt,
    tokenSigner: entitlement.signer,
  };
}

/**
 * Issues a live-stream entitlement for a FOX channel on Apple TV.
 */
async function requestLiveEntitlement(data) {
  const startTime = Date.now();
  const sessionId = uuidv4();

  const channelId = sanitizeText(data.channelId, 40).toLowerCase();
  const device = sanitizeText(data.device, 40) || 'unknown';
  const client = sanitizeText(data.client, 40) || 'unknown';

  if (!channelId) {
    const validationError = new Error('Select a channel to watch live.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_ENTITLEMENT_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Requesting FOX live entitlement', {
    sessionId,
    channelId,
    device,
    service: 'customer-fox-live-entitlement',
    route: '/api/fox/live/entitlement',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));

    const viewer = findViewer(data.profileId);
    const channel = findChannel(channelId);
    const entitlement = issueEntitlement(viewer, channel);
    const result = buildPlaybackSession(sessionId, viewer, channel, { channelId, device }, entitlement);

    const duration = Date.now() - startTime;
    incrementMetric('fox_live_entitlement.success', {
      route: '/api/fox/live/entitlement',
      channel: channelId,
    });
    recordTiming('fox_live_entitlement.latency', duration, { route: '/api/fox/live/entitlement' });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('fox_live_entitlement.failure', {
      route: '/api/fox/live/entitlement',
      errorClass: error.name,
    });
    recordTiming('fox_live_entitlement.latency', duration, {
      route: '/api/fox/live/entitlement',
      error: 'true',
    });

    if (error.statusCode && error.statusCode < 500) {
      logger.warn('FOX live entitlement rejected', {
        sessionId,
        error: error.message,
        errorClass: error.name,
        durationMs: duration,
        service: 'customer-fox-live-entitlement',
      });
      throw error;
    }

    logger.error('FOX live entitlement failed', {
      sessionId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      channelId,
      device,
      service: 'customer-fox-live-entitlement',
    });

    // Deliberately not reported to Sentry: this vertical raises its own branded
    // alert and Devin session below, and a Sentry issue would fan the same 500
    // out to the generic webhook path as a second, unguarded card and session.

    const blockReason = alertBlockReason(data.demoToken);
    if (blockReason) {
      logger.warn(`Suppressing FOX alert — ${blockReason}`, {
        sessionId,
        client,
        service: 'customer-fox-live-entitlement',
      });
      throw error;
    }

    createSessionAndAlert({
      issueTitle: `${error.name}: ${sanitizeText(error.message, 200)}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/fox.js \u2014 resolveTokenSigner',
      errorType: error.name || 'Error',
      errorValue: error.message,
      ...resolveDevinIdentity(data),
      service: 'customer-fox-live-entitlement',
      verticalLabel: 'FOX Live Entitlement (tvOS)',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'fox',
      tags: [
        { key: 'route', value: '/api/fox/live/entitlement' },
        { key: 'service', value: 'customer-fox-live-entitlement' },
        { key: 'client', value: client },
        { key: 'channel', value: channelId },
      ],
      extra: { sessionId, channelId, device },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-fox-live-entitlement@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for FOX entitlement error', {
        error: err.message,
        sessionId,
      });
    });

    throw error;
  }
}

module.exports = {
  requestLiveEntitlement,
  alerting,
  REMEDIATION_DIRECTIVE,
  CHANNELS,
  TOKEN_SIGNERS,
};
