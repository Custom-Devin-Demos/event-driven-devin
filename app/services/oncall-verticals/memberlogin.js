const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const SESSION_ROUTE = '/api/oncall/memberlogin/session';
const SERVICE = 'member-auth-api';
const RELEASE = 'v7.34';

const USER_ID_RE = /^[A-Za-z0-9._-]{3,64}$/;
const SESSION_TTL_SECONDS = 15 * 60;
const CREDENTIAL_CHECK_LATENCY_MS = [140, 260];

/**
 * Token issuers by release. v7.34 moves members onto the session-v2 issuer
 * through a staged rollout; everyone else stays on the session-v1 issuer.
 */
const SESSION_ISSUERS = {
  'session-v1': {
    issue(userId, issuedAtMs) {
      return { sub: userId, iat: issuedAtMs, exp: issuedAtMs + SESSION_TTL_SECONDS * 1000, iss: 'session-v1' };
    },
  },
  'session-v2': {
    issue(userId, issuedAtMs) {
      const iat = Math.floor(issuedAtMs / 1000);
      return { sub: userId, iat, exp: iat + SESSION_TTL_SECONDS, iss: 'session-v2' };
    },
  },
};

const RELEASE_CONFIG = {
  release: RELEASE,
  issuerRollout: { issuer: 'session-v2', percent: 20 },
  defaultIssuer: 'session-v1',
};

const ACCOUNT_TYPES = ['cards-banking', 'business', 'corporate'];

const delay = ([minMs, maxMs]) => new Promise((resolve) => {
  setTimeout(resolve, minMs + Math.random() * (maxMs - minMs));
});

function invalidLogin(message) {
  const error = new Error(message);
  error.code = 'INVALID_LOGIN';
  return error;
}

function rolloutBucket(userId) {
  const digest = crypto.createHash('sha256').update(userId.toLowerCase()).digest();
  return digest.readUInt32BE(0) % 100;
}

function issuerFor(userId) {
  const { issuerRollout, defaultIssuer } = RELEASE_CONFIG;
  return rolloutBucket(userId) < issuerRollout.percent ? issuerRollout.issuer : defaultIssuer;
}

function isSessionActive(token, nowMs = Date.now()) {
  return Boolean(token) && Number.isFinite(token.exp) && token.exp > nowMs;
}

function validateLogin(data) {
  const userId = typeof data.userId === 'string' ? data.userId.trim() : '';
  if (!USER_ID_RE.test(userId)) throw invalidLogin('Enter a valid User ID.');
  if (typeof data.password !== 'string' || !data.password) throw invalidLogin('Enter your password.');
  const accountType = ACCOUNT_TYPES.includes(data.accountType) ? data.accountType : 'cards-banking';
  return { userId, accountType };
}

function accountSummaryFor(userId) {
  const digest = crypto.createHash('sha256').update(`summary:${userId.toLowerCase()}`).digest();
  const cents = 25000 + (digest.readUInt32BE(0) % 450000);
  return {
    cardEnding: String(10000 + (digest.readUInt16BE(4) % 90000)),
    balance: cents / 100,
    minimumDue: Math.max(40, Math.round(cents * 0.02) / 100),
    pointsBalance: 1000 + (digest.readUInt32BE(6) % 240000),
  };
}

function sessionExpiredError() {
  const error = new Error('Session token rejected: expired');
  error.name = 'SessionExpiredError';
  error.code = 'SESSION_EXPIRED';
  return error;
}

async function createSession(data = {}) {
  const startedAt = Date.now();
  const login = validateLogin(data);
  const loginId = `LGN-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  incrementMetric('memberlogin.session.attempt', { route: SESSION_ROUTE, service: SERVICE, release: RELEASE });

  await delay(CREDENTIAL_CHECK_LATENCY_MS);
  const issuerName = issuerFor(login.userId);
  const token = SESSION_ISSUERS[issuerName].issue(login.userId, Date.now());
  const active = isSessionActive(token);
  const durationMs = Date.now() - startedAt;

  if (active) {
    incrementMetric('memberlogin.session.success', {
      route: SESSION_ROUTE, service: SERVICE, release: RELEASE, issuer: issuerName,
    });
    recordTiming('memberlogin.session.latency', durationMs, { route: SESSION_ROUTE, service: SERVICE });
    logger.info('Member session created', {
      loginId, issuer: issuerName, release: RELEASE, durationMs, service: SERVICE, route: SESSION_ROUTE,
    });
    return {
      success: true,
      loginId,
      accountType: login.accountType,
      account: accountSummaryFor(login.userId),
    };
  }

  const error = sessionExpiredError();
  error.loginId = loginId;
  incrementMetric('memberlogin.session.rejected', {
    route: SESSION_ROUTE, service: SERVICE, release: RELEASE, issuer: issuerName, reason: 'expired',
  });
  recordTiming('memberlogin.session.latency', durationMs, { route: SESSION_ROUTE, service: SERVICE, error: 'true' });
  logger.error('Member session rejected', {
    loginId,
    code: error.code,
    errorClass: error.name,
    issuer: issuerName,
    tokenIat: token.iat,
    tokenExp: token.exp,
    validatedAt: Date.now(),
    release: RELEASE,
    durationMs,
    service: SERVICE,
    route: SESSION_ROUTE,
  });
  Sentry.captureException(error, {
    tags: { route: SESSION_ROUTE, service: SERVICE, release: RELEASE, issuer: issuerName },
    extra: { loginId },
  });
  throw error;
}

module.exports = {
  createSession,
  issuerFor,
  rolloutBucket,
  isSessionActive,
  SESSION_ISSUERS,
  RELEASE_CONFIG,
  RELEASE,
  SESSION_ROUTE,
};
