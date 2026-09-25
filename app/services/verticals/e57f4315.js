const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.WBD_SLACK_MEMBER_ID || 'U0BL94AFWM7';

const PORTFOLIO = [
  {
    segment: 'Streaming',
    regionCode: 'NA',
    networks: [
      { name: 'HBO Max', category: 'Direct-to-consumer' },
      { name: 'discovery+', category: 'Direct-to-consumer' },
    ],
  },
  {
    segment: 'Studios',
    regionCode: 'NA',
    networks: [
      { name: 'Warner Bros. Pictures', category: 'Theatrical' },
      { name: 'Warner Bros. Television Group', category: 'Television' },
      { name: 'New Line Cinema', category: 'Theatrical' },
      { name: 'Warner Bros. Games', category: 'Interactive' },
    ],
  },
  {
    segment: 'Global Networks',
    regionCode: 'NA',
    networks: [
      { name: 'CNN', category: 'News' },
      { name: 'TNT Sports', category: 'Sports' },
      { name: 'Discovery Channel', category: 'Factual' },
      { name: 'TLC', category: 'Lifestyle' },
      { name: 'Food Network', category: 'Lifestyle' },
      { name: 'HGTV', category: 'Lifestyle' },
      { name: 'Cartoon Network', category: 'Kids' },
      { name: 'Adult Swim', category: 'Animation' },
    ],
  },
  {
    segment: 'Global Networks',
    regionCode: 'EMEA',
    networks: [
      { name: 'Eurosport', category: 'Sports' },
      { name: 'DMAX', category: 'Factual' },
      { name: 'Quest', category: 'Factual' },
      { name: 'TVN', category: 'Entertainment' },
    ],
  },
  {
    segment: 'Global Networks',
    regionCode: 'LATAM',
    networks: [
      { name: 'Discovery en Español', category: 'Factual' },
      { name: 'CNN en Español', category: 'News' },
      { name: 'Hogar HGTV', category: 'Lifestyle' },
    ],
  },
];

const REGIONS = {
  'north-america': { code: 'NA', label: 'North America' },
  emea: { code: 'EMEA', label: 'Europe, Middle East & Africa' },
  latam: { code: 'LATAM', label: 'Latin America' },
  apac: { code: 'APAC', label: 'Asia Pacific' },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Warner Bros. Discovery brand directory:',
  '- Service: `app/services/verticals/e57f4315.js`',
  '- Route: `app/routes/verticals/e57f4315.js`',
  '- Page: `app/public/verticals/e57f4315.html` (served at `/e57f4315`)',
  '',
  'Preserve the existing behavior for every segment and region in the portfolio.',
  'Run `npm run lint` and verify the "View All Brands" action on `/e57f4315` returns the directory.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function resolveRegion(regionSlug) {
  const region = REGIONS[String(regionSlug || '').toLowerCase()];

  if (!region) {
    const error = new Error('That region is not part of the published brand portfolio.');
    error.name = 'ValidationError';
    error.code = 'REGION_NOT_SUPPORTED';
    error.statusCode = 400;
    throw error;
  }

  return region;
}

function buildPortfolioIndex() {
  const index = { regions: {}, segments: [] };

  for (const entry of PORTFOLIO) {
    const key = entry.regionCode.toLowerCase();

    if (!index.regions[key]) {
      index.regions[key] = { segments: {}, networkCount: 0 };
    }

    index.regions[key].segments[entry.segment] = entry.networks;
    index.regions[key].networkCount += entry.networks.length;

    if (!index.segments.includes(entry.segment)) {
      index.segments.push(entry.segment);
    }
  }

  return index;
}

function buildRegionRollup(index, region) {
  const regionIndex = index.regions[region.code];
  const segments = Object.keys(regionIndex.segments).map((segment) => ({
    segment,
    networks: regionIndex.segments[segment],
    networkCount: regionIndex.segments[segment].length,
  }));

  return {
    segments,
    networkCount: regionIndex.networkCount,
    segmentCount: segments.length,
  };
}

function buildBrandDirectory(requestId, region, rollup) {
  return {
    success: true,
    requestId,
    region: {
      code: region.code,
      label: region.label,
    },
    portfolio: {
      segments: rollup.segments,
      segmentCount: rollup.segmentCount,
      networkCount: rollup.networkCount,
    },
    generatedAt: new Date().toISOString(),
  };
}

async function listBrandDirectory(data) {
  const startTime = Date.now();
  const requestId = `WBD-${uuidv4().slice(0, 8).toUpperCase()}`;
  const region = resolveRegion(data.region || 'north-america');

  logger.info('Building Warner Bros. Discovery brand directory', {
    requestId,
    region: region.code,
    service: 'customer-e57f4315-brand-directory',
    route: '/api/e57f4315/brand-directory',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const index = buildPortfolioIndex();
    const rollup = buildRegionRollup(index, region);
    const result = buildBrandDirectory(requestId, region, rollup);
    const duration = Date.now() - startTime;

    incrementMetric('brand_directory.request_success', {
      route: '/api/e57f4315/brand-directory',
      region: region.code,
    });
    recordTiming('brand_directory.request_latency', duration, {
      route: '/api/e57f4315/brand-directory',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('brand_directory.request_failure', {
      route: '/api/e57f4315/brand-directory',
      region: region.code,
      errorClass: error.name,
    });
    recordTiming('brand_directory.request_latency', duration, {
      route: '/api/e57f4315/brand-directory',
      error: 'true',
    });

    logger.error('Warner Bros. Discovery brand directory request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      region: region.code,
      service: 'customer-e57f4315-brand-directory',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/e57f4315/brand-directory',
        service: 'customer-e57f4315-brand-directory',
        region: region.code,
      },
      extra: {
        requestId,
        region: region.label,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e57f4315.js — buildRegionRollup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-e57f4315-brand-directory',
      verticalLabel: 'Warner Bros. Discovery Brand Directory',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'e57f4315',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/e57f4315/brand-directory' },
        { key: 'service', value: 'customer-e57f4315-brand-directory' },
        { key: 'region', value: region.code },
      ],
      extra: {
        requestId,
        region: region.label,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-e57f4315-brand-directory@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for brand directory error', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  listBrandDirectory,
  buildPortfolioIndex,
  buildRegionRollup,
  resolveRegion,
};
