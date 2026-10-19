/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.BLUEMOUNTAIN_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-3c9e1f7a-audit-readiness';
const ROUTE = '/api/3c9e1f7a/audit-readiness';

const LATENCY_SLO = { budgetMs: 3000 };
const RECORD_FETCH_POLICY = { latencyMs: [450, 550] };

const ASSET_CLASSES = {
  pipettes: { label: 'Pipettes', system: 'Precision instrument registry' },
  analytical_balances: { label: 'Analytical balances', system: 'Metrology equipment store' },
  temperature_controllers: { label: 'Temperature controllers', system: 'Process control historian' },
  ph_meters: { label: 'pH meters', system: 'Laboratory instrument system' },
  hplc_systems: { label: 'HPLC systems', system: 'Chromatography asset database' },
  autoclaves: { label: 'Autoclaves', system: 'Sterilization equipment records' },
  stability_chambers: { label: 'Stability chambers', system: 'Environmental chamber monitor' },
  freezers: { label: 'Freezers (-80 °C)', system: 'Cold-chain equipment registry' },
  pressure_gauges: { label: 'Pressure gauges', system: 'Utilities calibration repository' },
  torque_tools: { label: 'Torque tools', system: 'Packaging line instrument store' },
  thermocouples: { label: 'Thermocouples', system: 'Thermal validation archive' },
  flow_meters: { label: 'Flow meters', system: 'Process instrumentation database' },
  spectrophotometers: { label: 'Spectrophotometers', system: 'Analytical equipment system' },
  environmental_sensors: { label: 'Environmental monitoring sensors', system: 'Facility monitoring platform' },
};

const ALL_ASSET_CLASSES = Object.keys(ASSET_CLASSES);

function createRecords(rows) {
  return Object.fromEntries(ALL_ASSET_CLASSES.map((key, index) => {
    const [assets, dueSoon, overdue, outOfTolerance] = rows[index];
    return [key, {
      assets,
      dueSoon,
      overdue,
      outOfTolerance,
    }];
  }));
}

const SITES = {
  state_college: {
    label: 'State College, PA',
    records: createRecords([
      [186, 12, 2, 1],
      [74, 5, 0, 0],
      [42, 4, 0, 0],
      [38, 3, 1, 0],
      [31, 2, 0, 0],
      [19, 2, 0, 0],
      [26, 1, 0, 0],
      [22, 1, 0, 0],
      [58, 6, 0, 0],
      [64, 3, 0, 0],
      [48, 2, 0, 0],
      [37, 2, 0, 0],
      [14, 1, 0, 0],
      [120, 8, 0, 0],
    ]),
  },
  port_matilda: {
    label: 'Port Matilda, PA',
    records: createRecords([
      [92, 7, 0, 0],
      [36, 3, 0, 0],
      [21, 2, 0, 0],
      [18, 1, 0, 0],
      [16, 1, 0, 0],
      [11, 1, 0, 0],
      [15, 2, 0, 0],
      [12, 1, 0, 0],
      [29, 2, 0, 0],
      [31, 2, 0, 0],
      [24, 1, 0, 0],
      [19, 1, 0, 0],
      [8, 1, 0, 0],
      [66, 4, 0, 0],
    ]),
  },
  raleigh: {
    label: 'Raleigh, NC',
    records: createRecords([
      [118, 8, 0, 0],
      [48, 3, 0, 0],
      [27, 2, 0, 0],
      [24, 2, 0, 0],
      [21, 1, 0, 0],
      [14, 1, 0, 0],
      [18, 1, 0, 0],
      [16, 1, 0, 0],
      [37, 3, 0, 0],
      [42, 2, 0, 0],
      [31, 2, 0, 0],
      [25, 1, 0, 0],
      [10, 1, 0, 0],
      [82, 5, 0, 0],
    ]),
  },
};

const SCOPE_OPTIONS = {
  all: { label: 'All GMP asset classes', classes: ALL_ASSET_CLASSES },
  ...Object.fromEntries(ALL_ASSET_CLASSES.map((key) => [
    key,
    { label: ASSET_CLASSES[key].label, classes: [key] },
  ])),
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Blue Mountain RAM audit readiness check:',
  '- Service: `app/services/verticals/3c9e1f7a.js`',
  '- Route: `app/routes/verticals/3c9e1f7a.js`',
  '- Page: `app/public/verticals/3c9e1f7a.html` (served at `/bluemountain`)',
  '- Test: `tests/3c9e1f7a-audit-readiness.test.js`',
  '',
  'The default "All GMP asset classes" check succeeds but takes ~7s, breaching the 3000ms latency budget. The culprit is `loadAssetClassRecords`.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-call latency.',
  'Preserve the response payload and per-class result order.',
  'Run `npx jest tests/3c9e1f7a-audit-readiness.test.js --runInBand` and `npx eslint app/routes/verticals/3c9e1f7a.js app/services/verticals/3c9e1f7a.js app/routes/sentry-webhook.js config/customers/3c9e1f7a.js`.',
  'Verify the default audit readiness check at `/bluemountain` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

async function fetchAssetClassRecords(site, classKey) {
  const [min, max] = RECORD_FETCH_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const assetClass = ASSET_CLASSES[classKey];
  return {
    key: classKey,
    label: assetClass.label,
    system: assetClass.system,
    ...site.records[classKey],
  };
}

async function loadAssetClassRecords(site, classes) {
  const results = [];
  for (const classKey of classes) {
    results.push(await fetchAssetClassRecords(site, classKey));
  }
  return results;
}

function summarize(results) {
  const totals = results.reduce((summary, record) => ({
    totalAssets: summary.totalAssets + record.assets,
    dueSoon: summary.dueSoon + record.dueSoon,
    overdue: summary.overdue + record.overdue,
    outOfTolerance: summary.outOfTolerance + record.outOfTolerance,
  }), {
    totalAssets: 0,
    dueSoon: 0,
    overdue: 0,
    outOfTolerance: 0,
  });
  const inTolerancePct = totals.totalAssets
    ? Number((((totals.totalAssets - totals.outOfTolerance) / totals.totalAssets) * 100).toFixed(1))
    : 100;
  const compliantClasses = results.filter((record) => !record.overdue && !record.outOfTolerance).length;

  return {
    ...totals,
    inTolerancePct,
    compliantClasses,
    needsAttentionClasses: results.length - compliantClasses,
  };
}

function validateAuditRequest(data) {
  if (!Object.hasOwn(SITES, data.site) || !Object.hasOwn(SCOPE_OPTIONS, data.scope)) {
    const error = new Error('Select a valid manufacturing site and GMP asset class scope.');
    error.name = 'ValidationError';
    error.code = 'AUDIT_READINESS_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, classesChecked, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      site: data.site,
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      classesChecked,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/3c9e1f7a.js — loadAssetClassRecords',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Blue Mountain RAM Audit Readiness',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '3c9e1f7a',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'site', value: data.site },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      classesChecked,
    },
    level: 'warning',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for Blue Mountain audit-readiness latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runAuditReadiness(data = {}) {
  const startTime = Date.now();
  const checkId = `RAM-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    site: String(requestData.site || 'state_college').trim().toLowerCase(),
    scope: String(requestData.scope || 'all').trim().toLowerCase(),
  };

  validateAuditRequest(normalized);

  const site = SITES[normalized.site];
  const scope = SCOPE_OPTIONS[normalized.scope];
  logger.info('Running Blue Mountain RAM audit readiness check', {
    checkId,
    site: normalized.site,
    scope: normalized.scope,
    classes: scope.classes.length,
    service: SERVICE,
    route: ROUTE,
  });

  const results = await loadAssetClassRecords(site, scope.classes);
  const summary = summarize(results);
  const durationMs = Date.now() - startTime;

  incrementMetric('audit_readiness.success', {
    route: ROUTE,
    site: normalized.site,
    scope: normalized.scope,
  });
  recordTiming('audit_readiness.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('audit_readiness.latency_budget_breach', {
      route: ROUTE,
      site: normalized.site,
      scope: normalized.scope,
    });
    logger.warn('Blue Mountain audit readiness exceeded latency budget', {
      checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      classesChecked: results.length,
      site: normalized.site,
      scope: normalized.scope,
      service: SERVICE,
    });
    logger.warn('Blue Mountain audit readiness latency breach — triggering Devin session', {
      checkId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      classesChecked: results.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    checkId,
    site: {
      key: normalized.site,
      label: site.label,
    },
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    classesChecked: results.length,
    results,
    summary,
    durationMs,
  };
}

module.exports = {
  runAuditReadiness,
  summarize,
  ASSET_CLASSES,
  ALL_ASSET_CLASSES,
  SCOPE_OPTIONS,
  SITES,
  RECORD_FETCH_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
