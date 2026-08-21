const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Beat catalog offered on the MiniBeats marketplace. Each beat is licensed
 * from its producer at a base price for a basic lease; higher tiers apply a
 * multiplier.
 */
const BEATS = [
  { id: 'midnight-drive', title: 'Midnight Drive', producer: 'Metro Vince', genre: 'Trap', bpm: 140, basePrice: 29, coverHue: 265 },
  { id: 'cold-summer', title: 'Cold Summer', producer: 'Kaya Beats', genre: 'Trap', bpm: 145, basePrice: 34, coverHue: 200 },
  { id: 'gritty-lane', title: 'Gritty Lane', producer: 'OTB Sound', genre: 'Drill', bpm: 144, basePrice: 29, coverHue: 0 },
  { id: 'north-wind', title: 'North Wind', producer: 'OTB Sound', genre: 'Drill', bpm: 142, basePrice: 39, coverHue: 220 },
  { id: 'lagos-nights', title: 'Lagos Nights', producer: 'Ayo Wave', genre: 'Afrobeat', bpm: 102, basePrice: 44, coverHue: 30 },
  { id: 'palm-groove', title: 'Palm Groove', producer: 'Ayo Wave', genre: 'Afrobeat', bpm: 108, basePrice: 29, coverHue: 130 },
  { id: 'golden-hour', title: 'Golden Hour', producer: 'Luna Keys', genre: 'R&B', bpm: 92, basePrice: 49, coverHue: 45 },
  { id: 'velvet-room', title: 'Velvet Room', producer: 'Luna Keys', genre: 'R&B', bpm: 88, basePrice: 34, coverHue: 320 },
  { id: 'corner-store', title: 'Corner Store', producer: 'Metro Vince', genre: 'Hip-Hop', bpm: 96, basePrice: 29, coverHue: 15 },
  { id: 'block-party', title: 'Block Party', producer: 'DJ Marrow', genre: 'Hip-Hop', bpm: 100, basePrice: 24, coverHue: 55 },
  { id: 'neon-rain', title: 'Neon Rain', producer: 'Synthea', genre: 'Electronic', bpm: 124, basePrice: 39, coverHue: 190 },
  { id: 'circuit-break', title: 'Circuit Break', producer: 'Synthea', genre: 'Electronic', bpm: 128, basePrice: 44, coverHue: 285 },
  { id: 'smoke-signal', title: 'Smoke Signal', producer: 'Kaya Beats', genre: 'Trap', bpm: 138, basePrice: 54, coverHue: 350 },
  { id: 'marble-floor', title: 'Marble Floor', producer: 'DJ Marrow', genre: 'Drill', bpm: 146, basePrice: 29, coverHue: 240 },
  { id: 'moonlit-tape', title: 'Moonlit Tape', producer: 'Luna Keys', genre: 'Lo-Fi', bpm: 78, basePrice: 19, coverHue: 160 },
];

/**
 * License tiers keyed by tier code. Each tier applies a multiplier to the
 * beat's basePrice and carries the license summary shown on the receipt.
 *
 * NOTE: the exclusive tier was re-keyed to exclusive-v2 during the FY26
 * licensing revamp migration; the storefront still sells it as `exclusive`.
 */
const LICENSE_TIERS = {
  basic: {
    name: 'Basic Lease (MP3)',
    multiplier: 1,
    summary: 'Non-exclusive basic lease — MP3 delivery, up to 5,000 streams.',
  },
  premium: {
    name: 'Premium Lease (WAV + stems)',
    multiplier: 2.5,
    summary: 'Non-exclusive premium lease — WAV + tracked-out stems, up to 100,000 streams.',
  },
  'exclusive-v2': {
    name: 'Exclusive License',
    multiplier: 10,
    summary: 'Exclusive license — full rights transfer, beat is delisted from the catalog.',
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the MiniBeats beat-marketplace vertical:',
  '- Service: `app/services/verticals/b47d51c2.js`',
  '- Route: `app/routes/verticals/b47d51c2.js`',
  '- Page: `app/public/verticals/b47d51c2.html` (served at `/beatstars`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findBeat(beatId) {
  return BEATS.find((beat) => beat.id === beatId);
}

/**
 * Resolve the license tier configuration for a checkout.
 */
function resolveLicenseTier(tier) {
  return LICENSE_TIERS[tier];
}

/**
 * Compute the license price for a beat at a given tier, rounded to whole USD.
 */
function computeLicensePrice(beat, tierConfig) {
  return Math.round(beat.basePrice * tierConfig.multiplier);
}

/**
 * Assemble the order confirmation returned to the buyer.
 */
function buildOrderConfirmation(orderId, beat, tier, tierConfig, price) {
  return {
    orderId,
    beatId: beat.id,
    beatTitle: beat.title,
    producer: beat.producer,
    tier,
    tierName: tierConfig.name,
    price,
    license: tierConfig.summary,
  };
}

/**
 * Process a beat license checkout from the marketplace page.
 */
async function checkoutBeat(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing beat checkout', {
    orderId,
    beatId: data.beatId,
    tier: data.tier,
    service: 'customer-b47d51c2-beat-marketplace',
    route: '/api/b47d51c2/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const beat = findBeat(data.beatId);
    if (!beat) {
      const notFound = new Error(`Unknown beat: ${data.beatId}`);
      notFound.name = 'NotFoundError';
      notFound.statusCode = 404;
      throw notFound;
    }

    const tierConfig = resolveLicenseTier(data.tier);
    const price = computeLicensePrice(beat, tierConfig);
    const confirmation = buildOrderConfirmation(orderId, beat, data.tier, tierConfig, price);

    incrementMetric('beat_checkout.received', {
      route: '/api/b47d51c2/checkout',
      tier: data.tier,
      genre: beat.genre,
    });
    recordTiming('beat_checkout.latency', Date.now() - startTime, {
      route: '/api/b47d51c2/checkout',
      error: 'false',
    });

    logger.info('Beat checkout completed', {
      orderId,
      beatId: beat.id,
      tier: data.tier,
      price,
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('beat_checkout.failure', {
      route: '/api/b47d51c2/checkout',
      errorClass: error.name,
      tier: data.tier || 'unknown',
    });
    recordTiming('beat_checkout.latency', duration, {
      route: '/api/b47d51c2/checkout',
      error: 'true',
    });

    logger.error('Beat checkout failed', {
      orderId,
      beatId: data.beatId,
      tier: data.tier,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-b47d51c2-beat-marketplace',
    });

    if (error.statusCode !== 404) {
      Sentry.captureException(error, {
        tags: {
          service: 'customer-b47d51c2-beat-marketplace',
          route: '/api/b47d51c2/checkout',
          tier: data.tier || 'unknown',
        },
        extra: {
          orderId,
          beatId: data.beatId,
          tier: data.tier,
        },
      });

      createSessionAndAlert({
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
        culprit: 'app/services/verticals/b47d51c2.js \u2014 computeLicensePrice',
        errorType: error.name || 'Error',
        errorValue: error.message,
        devinUserId: data.devinUserId,
        devinEmail: data.devinEmail,
        devinOrgId: data.devinOrgId,
        service: 'customer-b47d51c2-beat-marketplace',
        verticalLabel: 'Beat Marketplace Checkout',
        promptAppendix: REMEDIATION_DIRECTIVE,
        customer: 'default',
        tags: [
          { key: 'route', value: '/api/b47d51c2/checkout' },
          { key: 'service', value: 'customer-b47d51c2-beat-marketplace' },
          { key: 'tier', value: data.tier || 'unknown' },
        ],
        extra: {
          orderId,
          beatId: data.beatId,
          tier: data.tier,
        },
        level: 'error',
        platform: 'node',
        firstSeen: '',
        lastSeen: new Date().toISOString(),
      }).catch((alertError) => {
        logger.error('Failed to post alert for beat checkout error', {
          orderId,
          error: alertError.message,
        });
      });
    }

    throw error;
  }
}

module.exports = {
  checkoutBeat,
  BEATS,
  LICENSE_TIERS,
};
