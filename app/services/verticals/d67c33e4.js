const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  SERVICE_TIERS,
  SITES,
  SKUS,
  POSITIONS,
  positionsForSite,
  getSite,
  getSku,
} = require('./d67c33e4-network');

const SLACK_MEMBER_ID = process.env.D67C33E4_SLACK_MEMBER_ID || 'U0BU46F4WCU';

const PLANNING_HORIZONS = {
  7: { label: '1 week', weeks: 1 },
  14: { label: '2 weeks', weeks: 2 },
  28: { label: '4 weeks', weeks: 4 },
};

const SEASONAL_UPLIFT = [1, 1.08, 1.14, 1.05];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the stock & inventory control tower replenishment run:',
  '- Service: `app/services/verticals/d67c33e4.js`',
  '- Network master data: `app/services/verticals/d67c33e4-network.js`',
  '- Route: `app/routes/verticals/d67c33e4.js`',
  '- Page: `app/public/verticals/d67c33e4.html` (served at `/d67c33e4`)',
  '',
  'Every replenishment run fails before a single order line is produced. The plan',
  'must return an order line per site and SKU below its coverage target, with a',
  'safety-stock allowance that reflects the service tier assigned to the site —',
  'no `NaN`, `null` or zero-filled quantities in the response.',
  'Run `npx jest tests/d67c33e4-replenishment.test.js --runInBand` and `npm run lint`,',
  'then verify a replenishment run at `/d67c33e4` returns a plan for every site.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validateRun(data) {
  if (!Array.isArray(data.siteIds) || data.siteIds.length === 0) {
    const error = new Error('Select at least one site to include in the replenishment run.');
    error.name = 'ValidationError';
    error.code = 'NO_SITES_SELECTED';
    error.statusCode = 400;
    throw error;
  }

  const unknownSiteIds = data.siteIds.filter((siteId) => !getSite(siteId));
  if (unknownSiteIds.length > 0) {
    const error = new Error(`Unknown site ID(s) in this network: ${unknownSiteIds.join(', ')}`);
    error.name = 'ValidationError';
    error.code = 'UNKNOWN_SITE';
    error.statusCode = 400;
    throw error;
  }

  if (!PLANNING_HORIZONS[data.horizonDays]) {
    const error = new Error(`Unsupported planning horizon: ${data.horizonDays} days.`);
    error.name = 'ValidationError';
    error.code = 'HORIZON_UNSUPPORTED';
    error.statusCode = 400;
    throw error;
  }
}

function resolveSafetyStock(site, weeklyDemand) {
  const tier = SERVICE_TIERS[site.serviceTier] || {};
  return Math.round((weeklyDemand / 7) * tier.safetyStockDays);
}

function buildDemandSignal(position, site, weeks) {
  const weeklyUnits = [];
  for (let week = 0; week < weeks; week += 1) {
    weeklyUnits.push(Math.round(position.weeklyDemand * SEASONAL_UPLIFT[week % SEASONAL_UPLIFT.length]));
  }
  return weeklyUnits;
}

function projectCoverage(signal, position, site) {
  const { weeklyUnits, safetyStockUnits } = signal;
  const horizonDemand = weeklyUnits.reduce((total, units) => total + units, 0);
  const available = position.onHand - position.allocated + position.inTransit;
  const weeklyAverage = horizonDemand / weeklyUnits.length;
  const target = horizonDemand + safetyStockUnits;

  return {
    available,
    horizonDemand,
    safetyStockUnits,
    target,
    coverageDays: weeklyAverage > 0 ? Math.round((available / weeklyAverage) * 7 * 10) / 10 : 0,
    shortfall: Math.max(target - available, 0),
    leadTimeDays: site.leadTimeDays,
  };
}

function buildOrderLine(position, site, coverage) {
  const sku = getSku(position.sku);
  const cases = Math.ceil(coverage.shortfall / sku.caseSize);
  const units = cases * sku.caseSize;

  return {
    siteId: site.id,
    siteName: site.name,
    sku: sku.id,
    skuName: sku.name,
    department: sku.department,
    available: coverage.available,
    horizonDemand: coverage.horizonDemand,
    safetyStockUnits: coverage.safetyStockUnits,
    coverageDays: coverage.coverageDays,
    cases,
    units,
    costPence: units * sku.unitCostPence,
    dispatchBy: dispatchDeadline(site.leadTimeDays),
  };
}

function dispatchDeadline(leadTimeDays) {
  const deadline = new Date(Date.now() + leadTimeDays * 24 * 60 * 60 * 1000);
  return deadline.toISOString().slice(0, 10);
}

function formatPlan(runId, data, lines) {
  const totalUnits = lines.reduce((total, line) => total + line.units, 0);
  const totalCostPence = lines.reduce((total, line) => total + line.costPence, 0);
  const sitesCovered = [...new Set(lines.map((line) => line.siteId))];

  return {
    success: true,
    runId,
    status: 'released_to_wms',
    horizon: PLANNING_HORIZONS[data.horizonDays].label,
    generatedAt: new Date().toISOString(),
    siteCount: sitesCovered.length,
    lineCount: lines.length,
    totalUnits,
    totalCostPence,
    totalCost: `£${(totalCostPence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    lines: lines.slice(0, 25),
  };
}

function buildReplenishmentLines(data) {
  const { weeks } = PLANNING_HORIZONS[data.horizonDays];
  const lines = [];

  for (const siteId of data.siteIds) {
    const site = getSite(siteId);
    for (const position of positionsForSite(siteId)) {
      const signal = buildDemandSignal(position, site, weeks);
      const coverage = projectCoverage(signal, position, site);
      if (coverage.shortfall > 0) {
        lines.push(buildOrderLine(position, site, coverage));
      }
    }
  }

  return lines.sort((a, b) => b.units - a.units);
}

function getNetwork() {
  return {
    horizons: Object.entries(PLANNING_HORIZONS).map(([days, horizon]) => ({
      days: Number(days),
      label: horizon.label,
    })),
    sites: SITES.map((site) => {
      const positions = positionsForSite(site.id);
      const onHand = positions.reduce((total, position) => total + position.onHand, 0);
      const allocated = positions.reduce((total, position) => total + position.allocated, 0);
      const inTransit = positions.reduce((total, position) => total + position.inTransit, 0);
      const weeklyDemand = positions.reduce((total, position) => total + position.weeklyDemand, 0);
      const available = onHand - allocated;
      const coverageDays = weeklyDemand > 0 ? Math.round(((available / weeklyDemand) * 7) * 10) / 10 : 0;

      return {
        ...site,
        tierLabel: (SERVICE_TIERS[site.serviceTier.toLowerCase().replace('_', '-')] || {}).label || site.serviceTier,
        onHand,
        allocated,
        inTransit,
        available,
        weeklyDemand,
        coverageDays,
        utilisation: Math.round((onHand / site.capacityUnits) * 1000) / 10,
        health: coverageDays < 7 ? 'at-risk' : coverageDays < 12 ? 'watch' : 'healthy',
      };
    }),
    skus: SKUS.map((sku) => {
      const positions = POSITIONS.filter((position) => position.sku === sku.id);
      const onHand = positions.reduce((total, position) => total + position.onHand, 0);
      const allocated = positions.reduce((total, position) => total + position.allocated, 0);
      const inTransit = positions.reduce((total, position) => total + position.inTransit, 0);
      const weeklyDemand = positions.reduce((total, position) => total + position.weeklyDemand, 0);
      const available = onHand - allocated;

      return {
        ...sku,
        onHand,
        allocated,
        inTransit,
        available,
        weeklyDemand,
        stockValuePence: onHand * sku.unitCostPence,
        coverageDays: weeklyDemand > 0 ? Math.round(((available / weeklyDemand) * 7) * 10) / 10 : 0,
        sitesBelowTarget: positions.filter((position) => position.onHand - position.allocated < position.weeklyDemand).length,
      };
    }),
  };
}

async function runReplenishment(data) {
  const startTime = Date.now();
  const runId = `RPL-${uuidv4().slice(0, 8).toUpperCase()}`;

  validateRun(data);

  logger.info('Running replenishment plan', {
    runId,
    siteCount: data.siteIds.length,
    horizonDays: data.horizonDays,
    service: 'd67c33e4-api',
    route: '/api/d67c33e4/replenishment',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const lines = buildReplenishmentLines(data);
    const plan = formatPlan(runId, data, lines);
    const duration = Date.now() - startTime;

    incrementMetric('replenishment.run_success', {
      route: '/api/d67c33e4/replenishment',
      sites: String(data.siteIds.length),
      horizonDays: String(data.horizonDays),
    });
    recordTiming('replenishment.run_latency', duration, {
      route: '/api/d67c33e4/replenishment',
    });

    return plan;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('replenishment.run_failure', {
      route: '/api/d67c33e4/replenishment',
      errorClass: error.name,
      horizonDays: String(data.horizonDays),
    });
    recordTiming('replenishment.run_latency', duration, {
      route: '/api/d67c33e4/replenishment',
      error: 'true',
    });

    logger.error('Replenishment run failed', {
      runId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      siteIds: data.siteIds,
      horizonDays: data.horizonDays,
      service: 'd67c33e4-api',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/d67c33e4/replenishment',
        service: 'd67c33e4-api',
        horizonDays: String(data.horizonDays),
        alert_path: 'instant',
      },
      extra: { runId, siteIds: data.siteIds },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/d67c33e4.js — projectCoverage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'd67c33e4-api',
      verticalLabel: 'Stock & Inventory Control Tower',
      promptAppendix: REMEDIATION_DIRECTIVE,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: '/api/d67c33e4/replenishment' },
        { key: 'service', value: 'd67c33e4-api' },
        { key: 'horizonDays', value: String(data.horizonDays) },
        { key: 'sites', value: String(data.siteIds.length) },
      ],
      extra: { runId, siteIds: data.siteIds, horizonDays: data.horizonDays },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'd67c33e4-api@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for replenishment error', {
        error: alertError.message,
        runId,
      });
    });

    throw error;
  }
}

module.exports = {
  runReplenishment,
  getNetwork,
  buildReplenishmentLines,
  buildDemandSignal,
  projectCoverage,
  resolveSafetyStock,
  formatPlan,
  PLANNING_HORIZONS,
  REMEDIATION_DIRECTIVE,
};
