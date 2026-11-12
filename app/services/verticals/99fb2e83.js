const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { launchContextFor, accessFor, libraryFor } = require('./99fb2e83-launch');

const SLACK_MEMBER_ID = process.env.C99FB2E83_SLACK_MEMBER_ID || '';
const SERVICE = 'player-signin-web';
const ROUTE = '/api/99fb2e83/sign-in';
const LABEL = 'Electronic Arts — ea.com Homepage Sign in';

const sessions = new Map();

function buildPlayerSession(context, access, library, requestId) {
  const issuedAt = Date.now();
  return {
    sessionId: `NUC-${requestId.slice(0, 8).toUpperCase()}`,
    displayName: context.player.displayName,
    platform: context.player.platform,
    locale: context.locale,
    access,
    library,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + 4 * 3600000).toISOString(),
  };
}

async function startSignIn(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const handoff = { entryPoint: data.entryPoint, deviceId: data.deviceId, locale: data.locale };

  logger.info('Player sign-in started', {
    requestId, entryPoint: data.entryPoint, locale: data.locale, service: SERVICE,
  });

  try {
    const context = launchContextFor(handoff);
    const access = accessFor(context);
    const library = libraryFor(context);
    const session = buildPlayerSession(context, access, library, requestId);

    const duration = Date.now() - startTime;
    incrementMetric('player_signin.success', { route: ROUTE, service: SERVICE, locale: data.locale });
    recordTiming('player_signin.latency', duration, { route: ROUTE });
    logger.info('Player session issued', { requestId, sessionId: session.sessionId, durationMs: duration });

    sessions.set(session.sessionId, session);
    return session;
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('player_signin.failure', {
      route: ROUTE, service: SERVICE, locale: data.locale, errorClass: error.name,
    });
    recordTiming('player_signin.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Player sign-in failed', {
      requestId, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    error.requestId = requestId;
    if (!error.statusCode) error.statusCode = 500;

    const context = {
      requestId,
      entryPoint: data.entryPoint || 'unknown',
      locale: data.locale || 'unknown',
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: '99fb2e83', locale: context.locale, alert_path: 'instant',
      },
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/99fb2e83.js — startSignIn',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: '99fb2e83',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: LABEL,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'locale', value: context.locale },
        { key: 'entry_point', value: context.entryPoint },
      ],
      extra: {
        ...context,
        promptContext: 'Players cannot sign in to their EA Account from the ea.com homepage: every Sign in from the account menu returns HTTP 500 before a player session is issued, so players cannot reach their library, EA Play membership or purchases.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@7.3.1`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'When you fix this, add regression tests that sign in every player in the identity directory, and record a browser video of /99fb2e83 showing account-menu Sign in succeeding.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = { startSignIn, SERVICE, ROUTE };
