const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listProducts } = require('./ddb178db-catalog');
const { authenticate } = require('./ddb178db-identity');
const { stepUpPolicyFor, deviceTrustRulesFor } = require('./ddb178db-security');

const SLACK_MEMBER_ID = process.env.CDDB178DB_SLACK_MEMBER_ID || '';
const SERVICE = 'olb-signin-web';
const ROUTE = '/api/ddb178db/sessions';

const sessions = new Map();

function buildSession(profile, policy, requestId) {
  const issuedAt = Date.now();
  return {
    sessionId: `OLB-${requestId.slice(0, 8).toUpperCase()}`,
    customerId: profile.customerId,
    firstName: profile.firstName,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + policy.sessionTtlMinutes * 60000).toISOString(),
    otpChannels: policy.otpChannels,
    transferLimit: policy.transferLimit,
    accounts: profile.accounts,
  };
}

function evaluateDevice(profile, policy, rules, deviceId) {
  const known = profile.devices.find((d) => d.deviceId === deviceId && d.trusted);
  return {
    deviceId: deviceId || null,
    trusted: Boolean(known),
    stepUpRequired: policy.requireOtpOnNewDevice && !known,
    rememberDays: rules.rememberDays,
    trustedDevices: profile.devices.length,
    maxTrustedDevices: rules.maxTrustedDevices,
  };
}

async function signIn(data) {
  const requestId = uuidv4();
  const startTime = Date.now();
  const profile = authenticate(data.onlineId);

  logger.info('Online banking sign-in started', {
    requestId, onlineId: profile.enteredId, customerId: profile.customerId, service: SERVICE,
  });

  try {
    const policy = stepUpPolicyFor(profile);
    const session = buildSession(profile, policy, requestId);
    const rules = deviceTrustRulesFor(profile);
    const device = evaluateDevice(profile, policy, rules, data.deviceId);

    const duration = Date.now() - startTime;
    incrementMetric('olb_signin.success', { route: ROUTE, service: SERVICE, segment: profile.enrollment.segment });
    recordTiming('olb_signin.latency', duration, { route: ROUTE });
    logger.info('Online banking session issued', {
      requestId, sessionId: session.sessionId, customerId: profile.customerId, stepUpRequired: device.stepUpRequired, durationMs: duration,
    });

    const result = { ...session, device, rememberId: Boolean(data.rememberId) };
    sessions.set(session.sessionId, result);
    return result;
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('olb_signin.failure', {
      route: ROUTE, service: SERVICE, segment: profile.enrollment.segment, errorClass: error.name,
    });
    recordTiming('olb_signin.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Online banking sign-in failed', {
      requestId, onlineId: profile.enteredId, customerId: profile.customerId, error: error.message, errorClass: error.name, durationMs: duration, service: SERVICE,
    });

    error.requestId = requestId;
    if (!error.statusCode) error.statusCode = 500;

    const context = {
      requestId,
      onlineId: profile.enteredId,
      customerId: profile.customerId,
      segment: profile.enrollment.segment,
      tier: profile.enrollment.tier,
      homeRegion: profile.homeRegion,
      trustedDevices: profile.devices.length,
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, customer: 'ddb178db', segment: profile.enrollment.segment, alert_path: 'instant',
      },
      extra: context,
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ddb178db.js — signIn',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: 'ddb178db',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Bank of America — Online Banking Sign-in',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'segment', value: profile.enrollment.segment },
        { key: 'tier', value: profile.enrollment.tier },
        { key: 'customer_id', value: profile.customerId },
      ],
      extra: {
        ...context,
        promptContext: 'Customers cannot sign in to Online Banking from the bankofamerica.com homepage: every Log in attempt returns HTTP 500 before a session is issued, locking all retail customers out of their accounts.',
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@7.14.2`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'When you fix this, add regression tests that sign in every profile in the identity directory, and record a browser video of /ddb178db showing Log in succeeding.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = { listProducts, signIn };
