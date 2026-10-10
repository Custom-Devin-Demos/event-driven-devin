/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.DILIGENT_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-8f970d35-compliance-check';
const ROUTE = '/api/8f970d35/compliance-check';

const LATENCY_SLO = { budgetMs: 3000 };
const FRAMEWORK_CHECK_POLICY = { latencyMs: [450, 550] };

const FRAMEWORKS = {
  sox: { label: 'SOX', name: 'Sarbanes-Oxley Act', domain: 'Financial reporting', controls: 42 },
  gdpr: { label: 'GDPR', name: 'EU General Data Protection Regulation', domain: 'Data privacy', controls: 36 },
  iso27001: { label: 'ISO 27001', name: 'ISO/IEC 27001:2022', domain: 'Information security', controls: 93 },
  nistcsf: { label: 'NIST CSF', name: 'NIST Cybersecurity Framework 2.0', domain: 'Cyber risk', controls: 106 },
  soc2: { label: 'SOC 2', name: 'SOC 2 Type II (Trust Services Criteria)', domain: 'Service assurance', controls: 64 },
  hipaa: { label: 'HIPAA', name: 'HIPAA Security Rule', domain: 'Health data', controls: 54 },
  pcidss: { label: 'PCI DSS', name: 'PCI DSS v4.0', domain: 'Payment card data', controls: 78 },
  ccpa: { label: 'CCPA', name: 'California Consumer Privacy Act', domain: 'Data privacy', controls: 24 },
  dora: { label: 'DORA', name: 'EU Digital Operational Resilience Act', domain: 'Operational resilience', controls: 48 },
  nis2: { label: 'NIS2', name: 'EU NIS2 Directive', domain: 'Cyber risk', controls: 40 },
  csrd: { label: 'ESG / CSRD', name: 'Corporate Sustainability Reporting Directive', domain: 'ESG reporting', controls: 32 },
  fcpa: { label: 'FCPA', name: 'Foreign Corrupt Practices Act', domain: 'Anti-bribery & corruption', controls: 22 },
  ukbribery: { label: 'UK Bribery Act', name: 'UK Bribery Act 2010', domain: 'Anti-bribery & corruption', controls: 18 },
  aml: { label: 'AML', name: 'Anti-Money Laundering (BSA / AMLD6)', domain: 'Financial crime', controls: 38 },
};

const ALL_FRAMEWORKS = Object.keys(FRAMEWORKS);

const SCOPE_OPTIONS = {
  all: { label: 'All frameworks', frameworks: ALL_FRAMEWORKS },
  ...Object.fromEntries(ALL_FRAMEWORKS.map((key) => [
    key,
    { label: FRAMEWORKS[key].label, frameworks: [key] },
  ])),
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Diligent One compliance check request:',
  '- Service: `app/services/verticals/8f970d35.js`',
  '- Route: `app/routes/verticals/8f970d35.js`',
  '- Page: `app/public/verticals/8f970d35.html` (served at `/diligent`)',
  '- Test: `tests/8f970d35-compliance-check.test.js`',
  '',
  'Compliance checks with the default "All frameworks" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'The culprit is `runFrameworkChecks` in the service.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-framework check latency.',
  'Preserve the response payload for every scope, including the order of per-framework results and the summary totals.',
  'Run `npx jest tests/8f970d35-compliance-check.test.js --runInBand` and `npm run lint`.',
  'Verify the default compliance check at `/diligent` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashCheck(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function statusFor(exceptions, controlsTested) {
  if (exceptions === 0) return 'compliant';
  if (exceptions / controlsTested <= 0.05) return 'needs_attention';
  return 'at_risk';
}

async function checkFramework(organization, frameworkKey) {
  const [min, max] = FRAMEWORK_CHECK_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const framework = FRAMEWORKS[frameworkKey];
  const hash = hashCheck(`${organization.toLowerCase()}:${frameworkKey}`);
  const controlsTested = framework.controls;
  const exceptions = hash % 7 < 3 ? 0 : (hash >>> 4) % Math.max(2, Math.ceil(controlsTested * 0.1));
  const controlsPassed = controlsTested - exceptions;

  return {
    framework: frameworkKey,
    label: framework.label,
    name: framework.name,
    domain: framework.domain,
    controlsTested,
    controlsPassed,
    exceptions,
    score: Math.round((controlsPassed / controlsTested) * 1000) / 10,
    status: statusFor(exceptions, controlsTested),
  };
}

/**
 * Check each framework in scope; results are returned in the scope's
 * framework order so the board report lists them consistently.
 */
async function runFrameworkChecks(organization, frameworks) {
  const results = [];
  for (const frameworkKey of frameworks) {
    results.push(await checkFramework(organization, frameworkKey));
  }
  return results;
}

function summarize(results) {
  const controlsTested = results.reduce((sum, result) => sum + result.controlsTested, 0);
  const controlsPassed = results.reduce((sum, result) => sum + result.controlsPassed, 0);
  return {
    frameworksChecked: results.length,
    compliant: results.filter((result) => result.status === 'compliant').length,
    needsAttention: results.filter((result) => result.status === 'needs_attention').length,
    atRisk: results.filter((result) => result.status === 'at_risk').length,
    controlsTested,
    controlsPassed,
    exceptions: controlsTested - controlsPassed,
    overallScore: Math.round((controlsPassed / controlsTested) * 1000) / 10,
  };
}

function validateCheckRequest(data) {
  const validOrganization = typeof data.organization === 'string'
    && data.organization.length >= 2
    && data.organization.length <= 120;
  const validScope = Object.hasOwn(SCOPE_OPTIONS, data.scope);

  if (!validOrganization || !validScope) {
    const error = new Error('Enter an organization name (2–120 characters) and a valid framework scope.');
    error.name = 'ValidationError';
    error.code = 'COMPLIANCE_CHECK_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, frameworksChecked, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      frameworksChecked,
      organization: data.organization,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/8f970d35.js — runFrameworkChecks',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Diligent One Compliance Check',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '8f970d35',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      frameworksChecked,
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
    logger.error('Failed to create Devin session for Diligent compliance-check latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runComplianceCheck(data = {}) {
  const startTime = Date.now();
  const checkId = `DIL-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    organization: requestData.organization === undefined || requestData.organization === null
      ? 'Northwind Holdings plc'
      : String(requestData.organization).trim(),
    scope: String(requestData.scope || 'all').trim().toLowerCase(),
  };

  validateCheckRequest(normalized);

  const scope = SCOPE_OPTIONS[normalized.scope];

  logger.info('Running Diligent compliance check', {
    checkId,
    organization: normalized.organization,
    scope: normalized.scope,
    frameworks: scope.frameworks.length,
    service: SERVICE,
    route: ROUTE,
  });

  const results = await runFrameworkChecks(normalized.organization, scope.frameworks);
  const summary = summarize(results);
  const durationMs = Date.now() - startTime;

  incrementMetric('compliance_check.success', {
    route: ROUTE,
    scope: normalized.scope,
  });
  recordTiming('compliance_check.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('compliance_check.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
    });
    logger.warn('Diligent compliance check exceeded latency budget', {
      checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      frameworksChecked: results.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    logger.warn('Diligent compliance check latency breach — triggering Devin session', {
      checkId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      frameworksChecked: results.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    checkId,
    organization: normalized.organization,
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    frameworksChecked: results.length,
    results,
    summary,
    durationMs,
  };
}

module.exports = {
  runComplianceCheck,
  summarize,
  FRAMEWORKS,
  ALL_FRAMEWORKS,
  SCOPE_OPTIONS,
  FRAMEWORK_CHECK_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
