const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Title catalog with per-region availability and account entitlement tiers.
 */
const TITLES = [
  {
    code: 'LOL',
    name: 'League of Legends',
    regions: ['NA1', 'EUW1', 'KR'],
    tiers: { standard: 'play', plus: 'play+esports' },
  },
  {
    code: 'VAL',
    name: 'VALORANT',
    regions: ['NA1', 'EUW1', 'AP'],
    tiers: { standard: 'play', plus: 'play+premier' },
  },
  {
    code: 'TFT',
    name: 'Teamfight Tactics',
    regions: ['NA1', 'EUW1', 'KR', 'AP'],
    tiers: { standard: 'play', plus: 'play+pass' },
  },
  {
    code: 'WR',
    name: 'Wild Rift',
    regions: ['NA1', 'AP'],
    tiers: { standard: 'play', plus: 'play' },
  },
];

/**
 * Load the entitlement catalog entries available for a shard region.
 */
function loadEntitlementCatalog(region) {
  return TITLES.filter((title) => title.regions.includes(region)).map((title) => ({
    code: title.code,
    name: title.name,
    tiers: title.tiers,
  }));
}

/**
 * Index catalog entries by title code for constant-time entitlement lookups.
 */
function indexEntitlements(catalog) {
  const index = {};
  for (const entry of catalog) {
    index[entry.titleCode] = { name: entry.name, tiers: entry.tiers };
  }
  return index;
}

/**
 * Build the account session profile returned after authentication.
 */
function buildAccountProfile(region, channel) {
  return {
    accountId: `acct-${uuidv4().slice(0, 12)}`,
    region,
    channel,
    plan: 'plus',
    linkedTitles: ['LOL', 'VAL', 'TFT'],
  };
}

/**
 * Resolve the entitlements granted to the account for each linked title.
 */
function resolveAccountEntitlements(profile, entitlementIndex) {
  return profile.linkedTitles.map((titleCode) => {
    const entry = entitlementIndex[titleCode];
    return {
      title: entry.name,
      code: titleCode,
      grant: entry.tiers[profile.plan] || entry.tiers.standard,
    };
  });
}

/**
 * Processes a player sign-in and session bootstrap request.
 */
async function processSignIn(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing player sign-in', {
    requestId,
    region: data.region,
    channel: data.channel,
    service: 'customer-6efdaec0-signin',
    route: '/api/6efdaec0/signin',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const catalog = loadEntitlementCatalog(data.region);
    const entitlementIndex = indexEntitlements(catalog);
    const profile = buildAccountProfile(data.region, data.channel);
    const entitlements = resolveAccountEntitlements(profile, entitlementIndex);

    const session = {
      requestId,
      accountId: profile.accountId,
      region: profile.region,
      entitlements,
      issuedAt: new Date().toISOString(),
      success: true,
    };

    const duration = Date.now() - startTime;

    incrementMetric('player_signin.success', {
      route: '/api/6efdaec0/signin',
      region: data.region,
    });
    recordTiming('player_signin.latency', duration, {
      route: '/api/6efdaec0/signin',
    });

    return session;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('player_signin.failure', {
      route: '/api/6efdaec0/signin',
      errorClass: error.name,
    });
    recordTiming('player_signin.latency', duration, {
      route: '/api/6efdaec0/signin',
      error: 'true',
    });

    logger.error('Player sign-in failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      region: data.region,
      channel: data.channel,
      service: 'customer-6efdaec0-signin',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/6efdaec0/signin',
        service: 'customer-6efdaec0-signin',
        region: data.region,
      },
      extra: { requestId, region: data.region, channel: data.channel },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6efdaec0.js \u2014 resolveAccountEntitlements',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-6efdaec0-signin',
      verticalLabel: 'Player Account Sign-In',
      customer: '6efdaec0',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/6efdaec0/signin' },
        { key: 'service', value: 'customer-6efdaec0-signin' },
        { key: 'region', value: data.region },
      ],
      extra: { requestId, region: data.region, channel: data.channel },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-6efdaec0-signin@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for sign-in error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processSignIn, TITLES };
