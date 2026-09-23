const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SHARED_ACCOUNTS = {
  '1054118903': {
    username: '1054118903',
    password: 'Demo@1234',
    fullName: 'Faisal Al-Dosari',
    segment: 'retail',
  },
  '1077650214': {
    username: '1077650214',
    password: 'Demo@1234',
    fullName: 'Sara Al-Qahtani',
    segment: 'tahweel_private',
  },
};

/**
 * One tenant per audience. Each tenant owns the loyalty account that carries
 * the demo failure and its own segment key, so registering one tenant's
 * segment profile leaves every other tenant's sign-in failing as before.
 *
 * Add a tenant by adding an entry here; it is served at /login/<slug> and
 * POST /api/login/<slug>/signin with no other change.
 */
const TENANTS = {
  default: {
    slug: 'default',
    label: 'Al Rajhi Bank — Sign In',
    account: {
      username: '1098342271',
      password: 'Demo@1234',
      fullName: 'Noura Al-Harbi',
      // the Mokafaa Plus segment shipped with the 2026 loyalty rollout
      segment: 'mokafaa_plus',
    },
  },
  nouf: {
    slug: 'nouf',
    label: 'Al Rajhi Bank — Sign In (Nouf)',
    account: {
      username: '1098342271',
      password: 'Demo@1234',
      fullName: 'Noura Al-Harbi',
      segment: 'mokafaa_plus_nouf',
    },
  },
};

function getTenant(slug) {
  const key = String(slug || 'default').trim().toLowerCase();
  return Object.hasOwn(TENANTS, key) ? TENANTS[key] : undefined;
}

// One directory per tenant, built once so a test (or a demo reset) can mutate
// a tenant's directory the same way it could when there was only one.
const DIRECTORIES = Object.fromEntries(
  Object.entries(TENANTS).map(([slug, tenant]) => [
    slug,
    { ...SHARED_ACCOUNTS, [tenant.account.username]: tenant.account },
  ]),
);

function directoryFor(tenant) {
  return DIRECTORIES[tenant.slug];
}

const DIRECTORY = DIRECTORIES.default;

// Customer segments registered with the digital banking access service.
const SEGMENT_PROFILES = {
  retail: {
    label: 'Retail Banking',
    permissions: ['accounts:view', 'transfers:local'],
    landingPage: '/accounts',
    sessionMinutes: 20,
  },
  tahweel_private: {
    label: 'Tahweel Private',
    permissions: ['accounts:view', 'transfers:local', 'transfers:international'],
    landingPage: '/private',
    sessionMinutes: 30,
  },
};

const LOGIN_SLACK_MEMBER_ID = process.env.LOGIN_SLACK_MEMBER_ID || 'U0C1N7TQ7MM';

const SENTRY_ISSUE_QUERY = 'is:unresolved segment profile';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the sign-in failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues; ignore every issue that is not from POST /api/login/signin and do not modify any other vertical. The failing surface is the Al Rajhi Bank sign-in page at app/public/verticals/login.html (page route GET /login), whose "Sign in" action posts to POST /api/login/signin in app/routes/verticals/login.js. The sign-in pipeline lives in app/services/verticals/login.js: signIn -> buildSession -> resolveSegmentProfile. resolveSegmentProfile looks up SEGMENT_PROFILES by the customer segment on the directory account, so a directory account whose segment has no registered profile cannot build a session. Use the segment named in the alert's segment tag as the remediation target: register that segment's access profile (label, permissions, landing page, session minutes) and keep unregistered segments failing as a handled configuration error rather than a TypeError. Verify by starting the server (node app/server.js) and signing in as the affected account, which must return a successful session, and confirm npm run lint and npm test pass.

The sign-in surface is served per tenant: /login and POST /api/login/signin are the default tenant, and /login/<slug> with POST /api/login/<slug>/signin are additional tenants declared in TENANTS. Each tenant owns its own loyalty account and its own segment key, so register a profile only for the segment named in the alert's segment tag and leave every other tenant's segment untouched.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the sign-in page for the affected tenant in a real browser, sign in as the affected account, and record your screen for the whole attempt so the recording shows the form, the click, and the successful sign-in that replaces the previous error panel. Attach a screenshot and an animated webp of the recording to the pull request under a "Fix Verification" heading.`;

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function resolveSegmentProfile(account) {
  return SEGMENT_PROFILES[account.segment];
}

function buildSession(account) {
  const profile = resolveSegmentProfile(account);

  return {
    sessionId: `ARB-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    fullName: account.fullName,
    username: account.username,
    segmentLabel: profile.label,
    permissions: profile.permissions,
    landingPage: profile.landingPage,
    expiresAt: new Date(Date.now() + profile.sessionMinutes * 60 * 1000).toISOString(),
  };
}

async function signIn(data) {
  const startTime = Date.now();
  const tenant = getTenant(data.tenant);

  if (!tenant) {
    throw validationError(`Unknown sign-in tenant "${data.tenant}"`, 'UNKNOWN_TENANT');
  }

  const username = String(data.username || '').trim();
  const account = directoryFor(tenant)[username];

  if (!username || !data.password) {
    throw validationError('Username and password are required', 'MISSING_CREDENTIALS');
  }
  if (!account || account.password !== data.password) {
    throw validationError('Incorrect username or password', 'INVALID_CREDENTIALS');
  }

  logger.info('Signing in customer', {
    username,
    segment: account.segment,
    service: 'identity-api',
    route: '/api/login/signin',
  });

  try {
    const session = buildSession(account);
    const duration = Date.now() - startTime;

    incrementMetric('login.success', {
      route: '/api/login/signin',
      segment: account.segment,
    });
    recordTiming('login.latency', duration, { route: '/api/login/signin' });

    return { success: true, session };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('login.failure', {
      route: '/api/login/signin',
      errorClass: error.name,
      segment: account.segment,
    });
    recordTiming('login.latency', duration, {
      route: '/api/login/signin',
      error: 'true',
    });

    logger.error('Sign-in failed', {
      username,
      segment: account.segment,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'identity-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/login/signin',
        service: 'identity-api',
        segment: account.segment,
        alert_path: 'instant',
      },
      extra: { username, segment: account.segment },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/login.js — buildSession',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'identity-api',
      verticalLabel: tenant.label,
      customer: 'login',
      slackMemberId: data.devinEmail ? '' : LOGIN_SLACK_MEMBER_ID,
      slackMemberIdFallback: LOGIN_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/login/signin' },
        { key: 'service', value: 'identity-api' },
        { key: 'segment', value: account.segment },
      ],
      extra: { username, segment: account.segment },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'identity-api@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for sign-in error', {
        username,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  signIn,
  buildSession,
  resolveSegmentProfile,
  getTenant,
  directoryFor,
  TENANTS,
  DIRECTORY,
  SEGMENT_PROFILES,
  REMEDIATION_DIRECTIVE,
};
