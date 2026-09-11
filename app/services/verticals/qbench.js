const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SAMPLES = {
  'S-260911-0042': {
    sampleId: 'S-260911-0042',
    client: 'Redwood Botanicals',
    matrix: 'Flower',
    batchId: 'B-2609-117',
    receivedAt: '2026-09-11T14:20:00.000Z',
    panelCode: 'heavy_metals',
    results: [
      { analyte: 'Arsenic', value: 0.12, unit: 'ppm' },
      { analyte: 'Cadmium', value: 0.08, unit: 'ppm' },
      { analyte: 'Lead', value: 0.31, unit: 'ppm' },
      { analyte: 'Mercury', value: 0.02, unit: 'ppm' },
    ],
  },
  'S-260911-0038': {
    sampleId: 'S-260911-0038',
    client: 'Redwood Botanicals',
    matrix: 'Flower',
    batchId: 'B-2609-117',
    receivedAt: '2026-09-11T13:05:00.000Z',
    panelCode: 'potency',
    results: [
      { analyte: 'THC', value: 21.4, unit: '%' },
      { analyte: 'CBD', value: 0.6, unit: '%' },
      { analyte: 'Total Cannabinoids', value: 24.1, unit: '%' },
    ],
  },
  'S-260910-0117': {
    sampleId: 'S-260910-0117',
    client: 'Harbor Nutraceuticals',
    matrix: 'Tincture',
    batchId: 'B-2609-104',
    receivedAt: '2026-09-10T18:41:00.000Z',
    panelCode: 'microbial',
    results: [
      { analyte: 'Total Yeast & Mold', value: 4200, unit: 'CFU/g' },
      { analyte: 'E. coli', value: 0, unit: 'CFU/g' },
      { analyte: 'Salmonella', value: 0, unit: 'CFU/g' },
    ],
  },
};

const TEST_PANELS = {
  potency: {
    code: 'potency',
    label: 'Cannabinoid Potency',
    method: 'HPLC-UV · SOP-CHM-014',
    turnaroundDays: 2,
  },
  microbial: {
    code: 'microbial',
    label: 'Microbial Contaminants',
    method: 'qPCR · SOP-MIC-021',
    turnaroundDays: 3,
  },
  heavy_metals: {
    code: 'heavy_metals',
    label: 'Heavy Metals',
    method: 'ICP-MS · SOP-CHM-031',
    turnaroundDays: 4,
  },
};

// Specification limits registered with the CoA engine, keyed by test panel
// code. A result passes when it sits at or under the analyte's action limit.
const SPEC_LIMITS = {
  potency: {
    label: 'Cannabinoid Potency',
    regulatoryRef: '16 CCR § 5724',
    analytes: {
      THC: { max: 35, unit: '%' },
      CBD: { max: 35, unit: '%' },
      'Total Cannabinoids': { max: 40, unit: '%' },
    },
  },
  microbial: {
    label: 'Microbial Contaminants',
    regulatoryRef: '16 CCR § 5720',
    analytes: {
      'Total Yeast & Mold': { max: 10000, unit: 'CFU/g' },
      'E. coli': { max: 0, unit: 'CFU/g' },
      Salmonella: { max: 0, unit: 'CFU/g' },
    },
  },
  // heavy_metals ships with the ICP-MS onboarding; spec limit registration pending
};

const SIGNATORIES = [
  { id: 'LD-01', name: 'Dr. Elena Marsh', title: 'Laboratory Director', panels: ['potency', 'heavy_metals'] },
  { id: 'LD-02', name: 'Dr. Owen Castellanos', title: 'Microbiology Lead', panels: ['microbial'] },
];

const QBENCH_SLACK_MEMBER_ID = process.env.QBENCH_SLACK_MEMBER_ID || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved analytes';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the QBench Certificate of Analysis failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/insurance/claim and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST /api/qbench/coa, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the QBench LIMS sample workbench at app/public/verticals/qbench.html (page route GET /qbench), whose "Generate Certificate of Analysis" action posts to POST /api/qbench/coa in app/routes/verticals/qbench.js. The CoA pipeline lives in app/services/verticals/qbench.js: generateCertificate -> evaluateResults -> resolveSpecLimits. Start at resolveSpecLimits: it looks up SPEC_LIMITS by the sample's test panel code, and the heavy_metals panel was onboarded with the ICP-MS method without registered specification limits, so the lookup returns undefined and evaluateResults dereferences it while reading the analyte limits. Register the missing panel's specification limits and make the lookup fail as a handled LIMS error that places the sample on QC hold instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing sample S-260911-0042 to /api/qbench/coa, which must return a successful certificate, and confirm npm run lint passes.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the /qbench page in a real browser, generate the CoA for sample S-260911-0042, and record your screen for the whole submission so the recording shows the workbench, the click, and the issued certificate that replaces the previous TypeError panel. Attach a screenshot of that certificate and an animated webp of the recording to the pull request under a "Fix Verification" heading, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until that browser evidence is attached.`;

function resolveSpecLimits(panel) {
  return SPEC_LIMITS[panel.code];
}

function assignSignatory(panel) {
  return SIGNATORIES.find((signatory) => signatory.panels.includes(panel.code));
}

function evaluateResults(sample, panel) {
  const limits = resolveSpecLimits(panel);
  const analyteLimits = limits.analytes;

  const evaluated = sample.results.map((result) => {
    const limit = analyteLimits[result.analyte];
    const passed = !limit || result.value <= limit.max;
    return {
      analyte: result.analyte,
      value: result.value,
      unit: result.unit,
      actionLimit: limit ? limit.max : null,
      status: passed ? 'pass' : 'fail',
    };
  });

  return {
    limits,
    analytes: evaluated,
    disposition: evaluated.every((row) => row.status === 'pass') ? 'pass' : 'fail',
  };
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'INVALID_SAMPLE';
  error.statusCode = 400;
  return error;
}

async function generateCertificate(data) {
  const startTime = Date.now();
  const certificateId = `COA-${uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const sampleId = data.sampleId;
  const sample = SAMPLES[sampleId];

  if (!sampleId || !String(sampleId).trim() || !sample) {
    throw validationError(`Unknown sample: ${sampleId || '(none)'}`);
  }

  const panel = TEST_PANELS[sample.panelCode];
  if (!panel) {
    throw validationError(`Unknown test panel: ${sample.panelCode}`);
  }
  if (!data.reviewedBy || !String(data.reviewedBy).trim()) {
    throw validationError('Reviewer is required to issue a certificate');
  }

  logger.info('Generating QBench certificate of analysis', {
    certificateId,
    sampleId,
    batchId: sample.batchId,
    panelCode: panel.code,
    service: 'customer-qbench-coa',
    route: '/api/qbench/coa',
  });

  try {
    const evaluation = evaluateResults(sample, panel);
    const signatory = assignSignatory(panel);
    const issuedAt = new Date().toISOString();
    const duration = Date.now() - startTime;

    incrementMetric('qbench_coa.generated', {
      route: '/api/qbench/coa',
      panelCode: panel.code,
      disposition: evaluation.disposition,
    });
    recordTiming('qbench_coa.latency', duration, {
      route: '/api/qbench/coa',
    });

    return {
      success: true,
      certificateId,
      status: 'issued',
      sampleId,
      batchId: sample.batchId,
      client: sample.client,
      matrix: sample.matrix,
      panel: panel.label,
      method: panel.method,
      regulatoryRef: evaluation.limits.regulatoryRef,
      disposition: evaluation.disposition,
      analytes: evaluation.analytes,
      reviewedBy: data.reviewedBy,
      signatory: {
        id: signatory.id,
        name: signatory.name,
        title: signatory.title,
      },
      issuedAt,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('qbench_coa.failed', {
      route: '/api/qbench/coa',
      errorClass: error.name,
      panelCode: panel.code,
    });
    recordTiming('qbench_coa.latency', duration, {
      route: '/api/qbench/coa',
      error: 'true',
    });

    logger.error('QBench certificate generation failed', {
      certificateId,
      sampleId,
      batchId: sample.batchId,
      panelCode: panel.code,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: 'customer-qbench-coa',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/qbench/coa',
        service: 'customer-qbench-coa',
        panelCode: panel.code,
      },
      extra: {
        certificateId,
        sampleId,
        batchId: sample.batchId,
        panelCode: panel.code,
        reviewedBy: data.reviewedBy,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/qbench.js — evaluateResults',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'customer-qbench-coa',
      verticalLabel: 'QBench LIMS — Certificate of Analysis',
      customer: 'qbench',
      slackMemberId: data.devinEmail ? '' : QBENCH_SLACK_MEMBER_ID,
      slackMemberIdFallback: QBENCH_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/qbench/coa' },
        { key: 'service', value: 'customer-qbench-coa' },
        { key: 'panelCode', value: panel.code },
        { key: 'batchId', value: sample.batchId },
      ],
      extra: {
        certificateId,
        sampleId,
        batchId: sample.batchId,
        panelCode: panel.code,
        reviewedBy: data.reviewedBy,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-qbench-coa@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for QBench CoA error', {
        certificateId,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  generateCertificate,
  resolveSpecLimits,
  evaluateResults,
  assignSignatory,
  SAMPLES,
  TEST_PANELS,
  SPEC_LIMITS,
  SIGNATORIES,
  REMEDIATION_DIRECTIVE,
};
