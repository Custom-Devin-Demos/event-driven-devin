const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { resolveHousehold } = require('./ea99f141-accounts');
const { primaryLineFor, entitlementsFor, portalFor } = require('./ea99f141-portal');

const SLACK_MEMBER_ID = process.env.CEA99F141_SLACK_MEMBER_ID || '';
const SERVICE = 'myaccount-signin-web';
const ROUTE = '/api/ea99f141/account-sessions';

const sessions = new Map();

function buildAccountSession(household, line, entitlements, portal, requestId) {
  const issuedAt = Date.now();
  return {
    sessionId: `MSA-${requestId.slice(0, 8).toUpperCase()}`,
    accountNumber: household.accountNumber,
    firstName: household.firstName,
    region: portal.region,
    primaryService: line.label,
    entitlements,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + portal.sessionTtlMinutes * 60000).toISOString(),
  };
}

async function startAccountSession(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const household = resolveHousehold({ serviceZip: data.serviceZip, deviceId: data.deviceId });

  logger.info('Account sign-in started', {
    requestId, entryPoint: data.entryPoint, accountNumber: household.accountNumber, footprint: household.footprint, service: SERVICE,
  });

  try {
    const portal = portalFor(household);
    const line = primaryLineFor(household);
    const entitlements = entitlementsFor(line);
    const session = buildAccountSession(household, line, entitlements, portal, requestId);

    const duration = Date.now() - startTime;
    incrementMetric('account_signin.success', { route: ROUTE, service: SERVICE, footprint: household.footprint });
    recordTiming('account_signin.latency', duration, { route: ROUTE });
    logger.info('Account session issued', {
      requestId, sessionId: session.sessionId, accountNumber: household.accountNumber, durationMs: duration,
    });

    sessions.set(session.sessionId, session);
    return session;
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('account_signin.failure', {
      route: ROUTE, service: SERVICE, footprint: household.footprint, errorClass: error.name,
    });
    recordTiming('account_signin.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Account sign-in failed', {
      requestId, accountNumber: household.accountNumber, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    error.requestId = requestId;
    if (!error.statusCode) error.statusCode = 500;

    const context = {
      requestId,
      entryPoint: data.entryPoint || 'unknown',
      accountNumber: household.accountNumber,
      footprint: household.footprint,
      primaryLine: household.primaryLine,
      serviceLines: Object.keys(household.services).join(','),
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: 'ea99f141', footprint: household.footprint, alert_path: 'instant',
      },
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ea99f141.js — startAccountSession',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: 'ea99f141',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Spectrum — Internet Homepage Sign in',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'footprint', value: household.footprint },
        { key: 'entry_point', value: context.entryPoint },
      ],
      extra: {
        ...context,
        promptContext: 'Customers cannot sign in to their account from the Spectrum Internet homepage: every hero Sign in attempt returns HTTP 500 before an account session is issued, so existing subscribers cannot reach billing, WiFi or support self-service.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@4.22.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'When you fix this, add regression tests that sign in every household in the account directory, and record a browser video of /ea99f141 showing hero Sign in succeeding.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = { startAccountSession, SERVICE, ROUTE };
