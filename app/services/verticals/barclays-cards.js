const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Cardmember accounts for the demo
 */
const CARDMEMBERS = [
  { id: 'CM-4001', username: 'jdoe_barclays', displayName: 'John Doe', cardType: 'rewards', status: 'active', lastLogin: '2026-03-10T14:22:00Z' },
  { id: 'CM-4002', username: 'asmith_barclays', displayName: 'Alice Smith', cardType: 'cashback', status: 'active', lastLogin: '2026-03-14T09:15:00Z' },
  { id: 'CM-4003', username: 'bwilson_barclays', displayName: 'Bob Wilson', cardType: 'travel', status: 'locked', lastLogin: '2026-02-28T17:45:00Z' },
  { id: 'CM-4004', username: 'mjohnson_barclays', displayName: 'Maria Johnson', cardType: 'premium', status: 'active', lastLogin: '2026-03-16T11:30:00Z' },
];

/**
 * Available credit card products
 */
const CARD_PRODUCTS = [
  { id: 'PROD-001', name: 'Barclays View Mastercard', apr: 20.24, annualFee: 0, rewardsRate: 1.5 },
  { id: 'PROD-002', name: 'AAdvantage Aviator Red', apr: 21.49, annualFee: 99, rewardsRate: 2.0 },
  { id: 'PROD-003', name: 'Wyndham Rewards Earner Plus', apr: 19.99, annualFee: 75, rewardsRate: 3.0 },
  { id: 'PROD-004', name: 'Old Navy Encore Mastercard', apr: 29.99, annualFee: 0, rewardsRate: 5.0 },
];

/**
 * Security rules for login validation
 */
const SECURITY_RULES = {
  maxAttempts: 5,
  lockoutMinutes: 30,
  sessionDurationMinutes: 20,
  requireMfa: false,
};

/**
 * Simulate a rate-limit check against a remote service.
 */
async function checkRateLimit(_username) {
  await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 50));
  const recentAttempts = Math.floor(Math.random() * 3);
  return { allowed: recentAttempts < SECURITY_RULES.maxAttempts, recentAttempts };
}

/**
 * Validate credentials against the cardmember store.
 */
async function validateCredentials(username, _password) {
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60));
  const member = CARDMEMBERS.find((m) => m.username === username);
  if (!member) {
    return { valid: false, reason: 'unknown_user' };
  }
  if (member.status === 'locked') {
    return { valid: false, reason: 'account_locked' };
  }
  return { valid: true, member };
}

/**
 * Build a session token payload for an authenticated cardmember.
 */
function buildSessionPayload(member, rateInfo) {
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + SECURITY_RULES.sessionDurationMinutes);
  return {
    sessionId: uuidv4(),
    memberId: member.id,
    displayName: member.displayName,
    cardType: member.cardType,
    loginAttempts: rateInfo.recentAttempts,
    expiresAt: expiresAt.toISOString(),
  };
}

/**
 * Process a cardmember login attempt.
 */
async function processLogin(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing cardmember login', {
    requestId,
    username: data.username,
    service: 'barclays-cards-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const rateCheck = await checkRateLimit(data.username);
    if (!rateCheck.allowed) {
      const err = new Error('Too many login attempts, account temporarily locked');
      err.code = 'RATE_LIMITED';
      throw err;
    }

    const authResult = validateCredentials(data.username, data.password);
    if (!authResult.valid) {
      const err = new Error('Invalid username or password');
      err.code = 'AUTH_FAILED';
      throw err;
    }

    const session = buildSessionPayload(authResult.member, rateCheck);
    const duration = Date.now() - startTime;

    incrementMetric('login.success', {
      route: '/api/barclays-cards/login',
      cardType: authResult.member.cardType,
    });
    recordTiming('login.latency', duration, {
      route: '/api/barclays-cards/login',
    });

    return {
      success: true,
      requestId,
      sessionId: session.sessionId,
      displayName: session.displayName,
      cardType: session.cardType,
      expiresAt: session.expiresAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('login.failure', {
      route: '/api/barclays-cards/login',
      errorClass: error.name,
    });
    recordTiming('login.latency', duration, {
      route: '/api/barclays-cards/login',
      error: 'true',
    });

    logger.error('Cardmember login failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      username: data.username,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/barclays-cards/login',
        service: 'barclays-cards-api',
      },
      extra: {
        requestId,
        username: data.username,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/barclays-cards.js — processLogin',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'barclays-cards-api',
      verticalLabel: 'Barclays Cards Login',
      tags: [
        { key: 'route', value: '/api/barclays-cards/login' },
        { key: 'service', value: 'barclays-cards-api' },
        { key: 'username', value: data.username },
      ],
      extra: { requestId, username: data.username },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'barclays-cards@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from login error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processLogin, CARDMEMBERS, CARD_PRODUCTS };
