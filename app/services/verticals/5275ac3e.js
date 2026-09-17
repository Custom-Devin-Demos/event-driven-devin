const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-5275ac3e-drop-reservation';
const ROUTE = '/api/5275ac3e/reserve';
const SLACK_MEMBER_ID = 'U08S7AVJ478';

const MEMBER_TIERS = {
  core: { label: 'Core', programCode: 'core_rewards', earlyAccessMinutes: 0 },
  elite: { label: 'Elite', programCode: 'elite_rewards', earlyAccessMinutes: 30 },
  summit: { label: 'Summit', programCode: 'summit_rewards', earlyAccessMinutes: 90 },
};

const LOYALTY_PROGRAMS = [
  {
    programCode: 'core_rewards',
    pointsMultiplier: 1,
    shippingUpgrade: 'standard',
    exchangeWindowDays: 30,
  },
  {
    programCode: 'elite_rewards',
    pointsMultiplier: 1.5,
    shippingUpgrade: 'two-day',
    exchangeWindowDays: 60,
  },
];

const DROP_CATALOG = {
  'air-series-9': {
    name: 'Air Series 9',
    silhouette: 'Road running',
    priceUsd: 165,
    colorway: 'Solar Flare / Black',
    releaseWindow: '2026-01-14T15:00:00.000Z',
  },
  'court-pro-mid': {
    name: 'Court Pro Mid',
    silhouette: 'Basketball',
    priceUsd: 140,
    colorway: 'Chalk / Crimson',
    releaseWindow: '2026-01-21T15:00:00.000Z',
  },
  'pitch-elite-fg': {
    name: 'Pitch Elite FG',
    silhouette: 'Firm ground',
    priceUsd: 210,
    colorway: 'Volt / Deep Sea',
    releaseWindow: '2026-01-28T15:00:00.000Z',
  },
};

const REGIONAL_INVENTORY = {
  'us-west': [
    { dropId: 'air-series-9', warehouse: 'LAX-3', units: 420 },
    { dropId: 'court-pro-mid', warehouse: 'LAX-3', units: 260 },
    { dropId: 'pitch-elite-fg', warehouse: 'SEA-1', units: 180 },
  ],
  'us-east': [
    { dropId: 'air-series-9', warehouse: 'EWR-2', units: 510 },
    { dropId: 'court-pro-mid', warehouse: 'ATL-4', units: 305 },
    { dropId: 'pitch-elite-fg', warehouse: 'EWR-2', units: 220 },
  ],
  emea: [
    { dropId: 'air-series-9', warehouse: 'AMS-1', units: 340 },
    { dropId: 'court-pro-mid', warehouse: 'AMS-1', units: 175 },
    { dropId: 'pitch-elite-fg', warehouse: 'MAD-2', units: 265 },
  ],
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the athletic retail launch reservation vertical:',
  '- Service: `app/services/verticals/5275ac3e.js`',
  '- Route: `app/routes/verticals/5275ac3e.js`',
  '- Page: `app/public/verticals/5275ac3e.html` (served at `/5275ac3e`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function resolveRegion(region) {
  const normalized = String(region || '').trim().toLowerCase();
  return REGIONAL_INVENTORY[normalized] ? normalized : 'us-west';
}

function resolveTier(membershipTier) {
  const normalized = String(membershipTier || '').trim().toLowerCase();
  return MEMBER_TIERS[normalized] || MEMBER_TIERS.core;
}

function allocateInventory(region, dropId) {
  const shelves = REGIONAL_INVENTORY[region] || REGIONAL_INVENTORY['us-west'];
  const shelf = shelves.find((entry) => entry.dropId === dropId) || shelves[0];

  return {
    warehouse: shelf.warehouse,
    unitsRemaining: shelf.units,
    allocationBand: shelf.units > 300 ? 'wide' : 'limited',
  };
}

/**
 * Index the loyalty programs by code so benefit lookups are O(1).
 */
function buildProgramIndex(programs) {
  const index = {};

  for (const program of programs) {
    index[program.programCode] = program;
  }

  return index;
}

function applyMemberBenefits(programIndex, tier) {
  const program = programIndex[tier.programCode];

  return {
    tier: tier.label,
    pointsMultiplier: program.pointsMultiplier,
    shippingUpgrade: program.shippingUpgrade,
    exchangeWindowDays: program.exchangeWindowDays,
    earlyAccessMinutes: tier.earlyAccessMinutes,
  };
}

function buildQueuePosition(allocation, benefits) {
  const base = allocation.allocationBand === 'wide' ? 1200 : 400;
  const advantage = Math.round(benefits.earlyAccessMinutes * 4.5);
  return Math.max(1, base - advantage);
}

async function reserveDrop(data) {
  const startTime = Date.now();
  const reservationId = uuidv4();
  const dropId = DROP_CATALOG[data.dropId] ? data.dropId : 'air-series-9';
  const size = data.size || 'M 10';

  logger.info('Processing launch reservation', {
    reservationId,
    dropId,
    size,
    region: data.region,
    membershipTier: data.membershipTier,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const region = resolveRegion(data.region);
    const drop = DROP_CATALOG[dropId];
    const tier = resolveTier(data.membershipTier);
    const allocation = allocateInventory(region, dropId);
    const programIndex = buildProgramIndex(LOYALTY_PROGRAMS);
    const benefits = applyMemberBenefits(programIndex, tier);
    const queuePosition = buildQueuePosition(allocation, benefits);
    const duration = Date.now() - startTime;

    incrementMetric('drop_reservation.success', { route: ROUTE, drop: dropId, region });
    recordTiming('drop_reservation.latency', duration, { route: ROUTE });

    return {
      success: true,
      reservationId,
      region,
      size,
      drop: {
        dropId,
        name: drop.name,
        silhouette: drop.silhouette,
        priceUsd: drop.priceUsd,
        colorway: drop.colorway,
        releaseWindow: drop.releaseWindow,
      },
      allocation,
      benefits,
      queuePosition,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const region = resolveRegion(data.region);

    incrementMetric('drop_reservation.failure', {
      route: ROUTE,
      errorClass: error.name,
      drop: dropId,
      region,
    });
    recordTiming('drop_reservation.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Launch reservation failed', {
      reservationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      dropId,
      size,
      region,
      membershipTier: data.membershipTier,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        drop: dropId,
        region,
        alert_path: 'instant',
      },
      extra: {
        reservationId,
        dropId,
        size,
        region,
        membershipTier: data.membershipTier,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/5275ac3e.js \u2014 applyMemberBenefits',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Launch Reservation',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '5275ac3e',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'drop', value: dropId },
        { key: 'region', value: region },
      ],
      extra: {
        reservationId,
        dropId,
        size,
        region,
        membershipTier: data.membershipTier,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for launch reservation error', {
        error: err.message,
        reservationId,
      });
    });

    throw error;
  }
}

module.exports = {
  reserveDrop,
  REMEDIATION_DIRECTIVE,
  MEMBER_TIERS,
  LOYALTY_PROGRAMS,
  DROP_CATALOG,
  REGIONAL_INVENTORY,
  resolveRegion,
  resolveTier,
  allocateInventory,
  buildProgramIndex,
  applyMemberBenefits,
  buildQueuePosition,
};
