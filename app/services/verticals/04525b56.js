/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CAMTEK_SLACK_MEMBER_ID || 'U08S7AVJ478';

const CUSTOMER_LABEL = 'Camtek';
const SERVICE = 'customer-04525b56-inspection-scan';
const ROUTE = '/api/04525b56/inspection-scan';
const DEFAULTS = {
  application: 'bump-copper-pillar',
  scanMode: 'full-wafer',
  waferId: 'LOT2471-W07',
};

const APPLICATIONS = {
  'bump-copper-pillar': {
    label: 'Bump & Copper Pillar',
    platform: 'Eagle-AP',
    diesPerZone: 96,
  },
  'cmos-image-sensor': {
    label: 'CMOS Image Sensors',
    platform: 'Golden Eagle',
    diesPerZone: 120,
  },
  'compound-semiconductors': {
    label: 'Compound Semiconductors',
    platform: 'Hawk',
    diesPerZone: 72,
  },
  'fan-out': {
    label: 'Fan-Out',
    platform: 'Eagle-AP',
    diesPerZone: 64,
  },
  rf: {
    label: 'RF',
    platform: 'Hawk',
    diesPerZone: 110,
  },
  mems: {
    label: 'MEMS',
    platform: 'Golden Eagle',
    diesPerZone: 88,
  },
  'heterogenous-integration': {
    label: 'Heterogenous Integration',
    platform: 'Eagle-AP',
    diesPerZone: 48,
  },
  'macro-inspection': {
    label: 'Macro Inspection',
    platform: 'Eagle-i',
    diesPerZone: 140,
  },
};

const ZONES = [
  'C1',
  'R1-N',
  'R1-E',
  'R1-S',
  'R1-W',
  'R2-NE',
  'R2-SE',
  'R2-SW',
  'R2-NW',
  'R3-N',
  'R3-E',
  'R3-S',
  'R3-W',
  'EDGE',
];

const SCAN_MODES = {
  'full-wafer': {
    label: 'Full-wafer scan (14 zones)',
    zones: ZONES,
    default: true,
  },
  'center-zone': {
    label: 'Center zone spot-check',
    zones: ['C1'],
    default: false,
  },
  'edge-ring': {
    label: 'Edge ring exclusion check',
    zones: ['EDGE'],
    default: false,
  },
};

const ZONE_INSPECTION_POLICY = { latencyMs: [450, 550] };
const LATENCY_SLO = { budgetMs: 3000 };

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Camtek wafer inspection scan request:',
  '- Service: `app/services/verticals/04525b56.js`',
  '- Route: `app/routes/verticals/04525b56.js`',
  '- Page: `app/public/verticals/04525b56.html` (served at `/camtek`)',
  '- Test: `tests/04525b56-inspection-scan.test.js`',
  '',
  'Full-wafer inspection scans succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency and fix it by parallelizing the sequential collectZoneInspections fan-out with Promise.all while preserving zone order.',
  'Preserve the 3000ms latency budget, breach alert, simulated per-zone latency in ZONE_INSPECTION_POLICY, and response shape.',
  'Run `npx jest tests/04525b56-inspection-scan.test.js --runInBand` and `npm run lint`.',
  'Verify the default full-wafer scan at `/camtek` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashInspection(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function inspectZone(application, waferId, zone) {
  const [min, max] = ZONE_INSPECTION_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const hash = hashInspection(`${application}:${waferId}:${zone}`);
  const diesInspected = APPLICATIONS[application].diesPerZone;
  const defects = zone === 'EDGE'
    ? (hash % 8) + 4
    : hash % 12;
  const defectClasses = {};
  const classNames = ['particle', 'scratch', 'bumpHeight', 'bridging', 'residue'];
  let remainingDefects = defects;
  classNames.slice(0, -1).forEach((className, index) => {
    const count = Math.min(remainingDefects, (hash >>> (index * 5)) % 4);
    defectClasses[className] = count;
    remainingDefects -= count;
  });
  defectClasses.residue = remainingDefects;

  const killerDefects = Math.min(defects, (hash >>> 20) % 5);

  return {
    zone,
    diesInspected,
    defects,
    killerDefects,
    knownGoodDies: diesInspected - killerDefects,
    defectClasses,
  };
}

async function collectZoneInspections(application, waferId, zones) {
  const inspections = [];
  for (const zone of zones) {
    inspections.push(await inspectZone(application, waferId, zone));
  }
  return inspections;
}

function createValidationError(message, code, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  error.requestId = requestId;
  return error;
}

function normalizeInspectionRequest(data) {
  const input = data && typeof data === 'object' ? data : {};
  const application = String(input.application || '').trim().toLowerCase() || DEFAULTS.application;
  const scanMode = String(input.scanMode || '').trim().toLowerCase() || DEFAULTS.scanMode;
  const waferId = String(input.waferId || '').trim().toUpperCase() || DEFAULTS.waferId;

  return {
    ...input,
    application,
    scanMode,
    waferId,
  };
}

function validateInspectionRequest(data, requestId) {
  if (!Object.hasOwn(APPLICATIONS, data.application)) {
    throw createValidationError('Select a valid inspection application.', 'INVALID_APPLICATION', requestId);
  }
  if (!Object.hasOwn(SCAN_MODES, data.scanMode)) {
    throw createValidationError('Select a valid inspection scan mode.', 'INVALID_SCAN_MODE', requestId);
  }
  if (!/^[A-Z0-9-]{4,20}$/.test(data.waferId)) {
    throw createValidationError('Enter a valid wafer ID (4–20 letters, numbers, or hyphens).', 'INVALID_WAFER_ID', requestId);
  }
}

function summarizeInspections(inspections) {
  const defectClassNames = ['particle', 'scratch', 'bumpHeight', 'bridging', 'residue'];
  const diesInspected = inspections.reduce((sum, inspection) => sum + inspection.diesInspected, 0);
  const defectsFound = inspections.reduce((sum, inspection) => sum + inspection.defects, 0);
  const killerDefects = inspections.reduce((sum, inspection) => sum + inspection.killerDefects, 0);
  const knownGoodDies = inspections.reduce((sum, inspection) => sum + inspection.knownGoodDies, 0);
  const defectClasses = Object.fromEntries(defectClassNames.map((className) => [
    className,
    inspections.reduce((sum, inspection) => sum + inspection.defectClasses[className], 0),
  ]));
  const worstZone = inspections.reduce((worst, inspection) => (
    !worst || inspection.killerDefects > worst.killerDefects ? inspection : worst
  ), null);

  return {
    diesInspected,
    defectsFound,
    killerDefects,
    knownGoodDies,
    yieldPct: Math.round((knownGoodDies / diesInspected) * 1000) / 10,
    defectClasses,
    worstZone: worstZone.zone,
  };
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, zoneCount, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      application: data.application,
      scanMode: data.scanMode,
      zoneCount: String(zoneCount),
    },
    extra: {
      requestId,
      waferId: data.waferId,
      durationMs,
      budgetMs,
      zoneCount,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'reportLatencyBreach(app/services/verticals/04525b56)',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Camtek Wafer Inspection Scan',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '04525b56',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'application', value: data.application },
      { key: 'scanMode', value: data.scanMode },
      { key: 'zoneCount', value: String(zoneCount) },
      { key: 'durationMs', value: String(durationMs) },
    ],
    extra: {
      requestId,
      waferId: data.waferId,
      durationMs,
      budgetMs,
      zoneCount,
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
    logger.error('Failed to create Devin session for Camtek inspection-scan latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runInspectionScan(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const normalized = normalizeInspectionRequest(data);
  validateInspectionRequest(normalized, requestId);

  const application = APPLICATIONS[normalized.application];
  const scanMode = SCAN_MODES[normalized.scanMode];

  logger.info('Running Camtek wafer inspection scan', {
    requestId,
    application: normalized.application,
    scanMode: normalized.scanMode,
    waferId: normalized.waferId,
    zoneCount: scanMode.zones.length,
    service: SERVICE,
    route: ROUTE,
  });

  const zones = await collectZoneInspections(
    normalized.application,
    normalized.waferId,
    scanMode.zones,
  );
  const durationMs = Date.now() - startTime;

  incrementMetric('inspection_scan.success', {
    route: ROUTE,
    application: normalized.application,
    scanMode: normalized.scanMode,
  });
  recordTiming('inspection_scan.latency', durationMs, {
    route: ROUTE,
    application: normalized.application,
    scanMode: normalized.scanMode,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('inspection_scan.latency_budget_breach', {
      route: ROUTE,
      application: normalized.application,
      scanMode: normalized.scanMode,
    });
    logger.warn('Camtek wafer inspection scan exceeded latency budget', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      application: normalized.application,
      scanMode: normalized.scanMode,
      zoneCount: zones.length,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      zoneCount: zones.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    requestId,
    customer: CUSTOMER_LABEL,
    waferId: normalized.waferId,
    application: {
      key: normalized.application,
      label: application.label,
      platform: application.platform,
    },
    scanMode: {
      key: normalized.scanMode,
      label: scanMode.label,
      zoneCount: zones.length,
    },
    recipe: `${application.platform}-${normalized.application}-R4.2`,
    zones,
    summary: summarizeInspections(zones),
    durationMs,
    latencyBudgetMs: LATENCY_SLO.budgetMs,
    inspectedAt: new Date().toISOString(),
  };
}

module.exports = {
  runInspectionScan,
  APPLICATIONS,
  ZONES,
  SCAN_MODES,
  ZONE_INSPECTION_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
