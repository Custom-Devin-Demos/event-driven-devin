const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Marriott Bonvoy elite tiers. `ledgerRegion` selects which points-ledger
 * shard holds the member's balance.
 */
const ELITE_TIERS = {
  member: { label: 'Member', ledgerRegion: 'global', redemptionBonusPct: 0 },
  silver: { label: 'Silver Elite', ledgerRegion: 'global', redemptionBonusPct: 0 },
  gold: { label: 'Gold Elite', ledgerRegion: 'global', redemptionBonusPct: 0 },
  platinum: { label: 'Platinum Elite', ledgerRegion: 'amer', redemptionBonusPct: 0 },
  titanium: { label: 'Titanium Elite', ledgerRegion: 'amer', redemptionBonusPct: 5 },
  ambassador: { label: 'Ambassador Elite', ledgerRegion: 'amer', redemptionBonusPct: 5 },
};

/**
 * Points-ledger shards by region. Every `ledgerRegion` referenced by a tier
 * must resolve to an active shard here before a debit can be posted.
 */
const LEDGER_SHARDS = {
  global: { id: 'bonvoy-ledger-01', endpoint: 'ledger-global.bonvoy.internal', active: true },
  emea: { id: 'bonvoy-ledger-04', endpoint: 'ledger-emea.bonvoy.internal', active: true },
  apac: { id: 'bonvoy-ledger-05', endpoint: 'ledger-apac.bonvoy.internal', active: true },
};

/**
 * Demo member profile returned by the (stubbed) member directory.
 */
const MEMBERS = {
  '184302771': { name: 'Neil Kelly', tier: 'titanium', pointsBalance: 148250 },
  '512330908': { name: 'Jordan Reyes', tier: 'gold', pointsBalance: 72400 },
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
  '  - Service: `app/services/verticals/bonvoy.js`',
  '  - Route: `app/routes/verticals/bonvoy.js` (`POST /api/bonvoy/points/redeem`)',
  '- Android client: `neil-z-kelly/bonvoy-android` (Kotlin / Jetpack Compose)',
  '  - Redeem flow: `app/src/main/java/com/marriott/bonvoy/ui/RedeemScreen.kt`',
  '  - View model: `app/src/main/java/com/marriott/bonvoy/ui/RedeemViewModel.kt`',
  '  - API client: `app/src/main/java/com/marriott/bonvoy/data/BonvoyApi.kt`',
  '',
  '*Scope:* Diagnose the backend failure, but do NOT change the backend — the points',
  'ledger outage is owned by another team. Fix the Android client instead: it currently',
  'renders the raw exception and stack trace to the member. Replace that with graceful',
  'error handling — a friendly, on-brand message explaining that points redemption is',
  'temporarily unavailable, a Retry action, and a way back to the hotel search — and',
  'surface the backend `error`/`message`/`requestId` fields only as subdued support details.',
  '',
  '*Deliverable:* Open a pull request against `main` in `neil-z-kelly/bonvoy-android`.',
  'Before opening it, build the debug APK, launch the `devin` AVD, install the app,',
  'sign in, pick a hotel, tap *Redeem points* against the live backend, and verify the',
  'new error state on screen. Record the emulator verification and attach it to the PR.',
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
 * Owner shown on the Bonvoy alert card. The Android client is unauthenticated,
 * so the demo owner is configured here rather than taken from the request.
 */
const BONVOY_OWNER_EMAIL = process.env.BONVOY_OWNER_EMAIL || 'neil.kelly@cognition.ai';

/**
 * Devin identities supplied by the caller are only honoured when the operator
 * has allow-listed them; otherwise the customer's configured identity is used.
 */
function resolveDevinIdentity(data) {
  const allowed = String(process.env.BONVOY_ALLOWED_DEVIN_ORG_IDS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const requestedOrgId = String(data.devinOrgId || '').trim();

  if (requestedOrgId && allowed.includes(requestedOrgId)) {
    return {
      devinOrgId: requestedOrgId,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail || BONVOY_OWNER_EMAIL,
    };
  }

  if (requestedOrgId) {
    logger.warn('Ignoring caller-supplied Devin identity for Bonvoy redemption', {
      requestedOrgId,
      service: 'customer-bonvoy-points-redemption',
    });
  }

  return { devinOrgId: undefined, devinUserId: undefined, devinEmail: BONVOY_OWNER_EMAIL };
}

function findMember(memberNumber) {
  const key = String(memberNumber || '').replace(/\s+/g, '');
  const member = MEMBERS[key];
  if (!member) {
    const error = new Error('Member number not found.');
    error.name = 'MemberNotFound';
    error.code = 'MEMBER_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }
  return member;
}

function resolveTier(tierCode) {
  return ELITE_TIERS[tierCode] || ELITE_TIERS.member;
}

/**
 * Price the stay in points, applying the tier's redemption bonus as a discount.
 */
function priceRedemption(points, tier) {
  const requested = Number(points);
  const bonus = Math.round((requested * tier.redemptionBonusPct) / 100);
  return { requested, bonus, pointsToDebit: requested - bonus };
}

/**
 * Resolve the ledger shard that owns this tier's balances.
 */
function resolveLedgerShard(tier) {
  const shard = LEDGER_SHARDS[tier.ledgerRegion];
  if (!shard || !shard.active) {
    const shardId = shard ? shard.id : `bonvoy-ledger-${tier.ledgerRegion}`;
    const error = new Error(
      `Loyalty points ledger is unavailable: shard ${shardId} for region ${tier.ledgerRegion.toUpperCase()} is not registered`,
    );
    error.name = 'PointsLedgerUnavailable';
    error.code = 'POINTS_LEDGER_UNAVAILABLE';
    error.statusCode = 500;
    throw error;
  }
  return shard;
}

/**
 * Post the debit to the member's ledger shard and return the new balance.
 */
function debitLedger(member, tier, pricing) {
  const shard = resolveLedgerShard(tier);
  if (pricing.pointsToDebit > member.pointsBalance) {
    const error = new Error('Not enough points available for this redemption.');
    error.name = 'InsufficientPoints';
    error.code = 'INSUFFICIENT_POINTS';
    error.statusCode = 400;
    throw error;
  }
  return {
    shard: shard.id,
    pointsDebited: pricing.pointsToDebit,
    newBalance: member.pointsBalance - pricing.pointsToDebit,
  };
}

function buildConfirmation(redemptionId, member, tier, data, pricing, ledger) {
  return {
    redemptionId,
    confirmationNumber: `BV${redemptionId.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
    status: 'confirmed',
    member: { name: member.name, tier: tier.label },
    hotel: data.hotel,
    nights: data.nights,
    pointsRequested: pricing.requested,
    eliteBonusPoints: pricing.bonus,
    pointsDebited: ledger.pointsDebited,
    newBalance: ledger.newBalance,
    ledgerShard: ledger.shard,
  };
}

/**
 * Redeems Marriott Bonvoy points for a hotel stay.
 */
async function redeemPoints(data) {
  const startTime = Date.now();
  const redemptionId = uuidv4();

  const nights = Number(data.nights);
  const points = Number(data.points);
  const hotel = sanitizeText(data.hotel);
  const client = sanitizeText(data.client, 40) || 'unknown';

  if (!hotel || !Number.isInteger(nights) || nights <= 0 || !Number.isInteger(points) || points <= 0) {
    const validationError = new Error('Select a hotel and at least one night to redeem points.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_REDEMPTION_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Redeeming Bonvoy points for stay', {
    redemptionId,
    hotel,
    nights,
    points,
    service: 'customer-bonvoy-points-redemption',
    route: '/api/bonvoy/points/redeem',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 180));

    const member = findMember(data.memberNumber);
    const tier = resolveTier(member.tier);
    const pricing = priceRedemption(points, tier);
    const ledger = debitLedger(member, tier, pricing);
    const result = buildConfirmation(redemptionId, member, tier, { hotel, nights }, pricing, ledger);

    const duration = Date.now() - startTime;
    incrementMetric('bonvoy_redemption.success', {
      route: '/api/bonvoy/points/redeem',
      tier: member.tier,
    });
    recordTiming('bonvoy_redemption.latency', duration, { route: '/api/bonvoy/points/redeem' });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('bonvoy_redemption.failure', {
      route: '/api/bonvoy/points/redeem',
      errorClass: error.name,
    });
    recordTiming('bonvoy_redemption.latency', duration, {
      route: '/api/bonvoy/points/redeem',
      error: 'true',
    });

    if (error.statusCode && error.statusCode < 500) {
      logger.warn('Bonvoy points redemption rejected', {
        redemptionId,
        error: error.message,
        errorClass: error.name,
        durationMs: duration,
        service: 'customer-bonvoy-points-redemption',
      });
      throw error;
    }

    logger.error('Bonvoy points redemption failed', {
      redemptionId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      hotel,
      nights,
      service: 'customer-bonvoy-points-redemption',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/bonvoy/points/redeem',
        service: 'customer-bonvoy-points-redemption',
        client,
      },
      extra: { redemptionId, hotel, nights, points },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${sanitizeText(error.message, 200)}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/bonvoy.js \u2014 resolveLedgerShard',
      errorType: error.name || 'Error',
      errorValue: error.message,
      ...resolveDevinIdentity(data),
      service: 'customer-bonvoy-points-redemption',
      verticalLabel: 'Marriott Bonvoy Points Redemption (Android)',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'bonvoy',
      tags: [
        { key: 'route', value: '/api/bonvoy/points/redeem' },
        { key: 'service', value: 'customer-bonvoy-points-redemption' },
        { key: 'client', value: client },
        { key: 'hotel', value: hotel },
      ],
      extra: { redemptionId, hotel, nights, points },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-bonvoy-points-redemption@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for Bonvoy redemption error', {
        error: err.message,
        redemptionId,
      });
    });

    throw error;
  }
}

module.exports = {
  redeemPoints,
  REMEDIATION_DIRECTIVE,
  ELITE_TIERS,
  LEDGER_SHARDS,
};
