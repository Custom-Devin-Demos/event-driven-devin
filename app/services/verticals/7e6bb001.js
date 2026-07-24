const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Simulated CVE vulnerability list (from Tenable scan results)
 * across Humana's digital health platform applications.
 */
const VULNERABILITIES = [
  { id: 'CVE-2024-38816', severity: 'CRITICAL', package: 'org.springframework:spring-webmvc', currentVersion: '5.3.27', fixedVersion: '5.3.39', application: 'MyHumana Member Portal', status: 'open', discoveredDate: '2026-07-20' },
  { id: 'CVE-2024-52316', severity: 'CRITICAL', package: 'org.apache.tomcat.embed:tomcat-embed-core', currentVersion: '10.1.24', fixedVersion: '10.1.33', application: 'Claims Adjudication Engine', status: 'open', discoveredDate: '2026-07-20' },
  { id: 'CVE-2024-22262', severity: 'HIGH', package: 'org.springframework:spring-web', currentVersion: '5.3.27', fixedVersion: '5.3.34', application: 'Medicare Enrollment Platform', status: 'open', discoveredDate: '2026-07-18' },
  { id: 'CVE-2024-47554', severity: 'HIGH', package: 'commons-io:commons-io', currentVersion: '2.11.0', fixedVersion: '2.14.0', application: 'CenterWell Pharmacy Services', status: 'in_progress', discoveredDate: '2026-07-18' },
  { id: 'CVE-2024-7254', severity: 'HIGH', package: 'com.google.protobuf:protobuf-java', currentVersion: '3.24.0', fixedVersion: '3.25.5', application: 'Interoperability FHIR Gateway', status: 'open', discoveredDate: '2026-07-16' },
  { id: 'CVE-2024-29025', severity: 'MEDIUM', package: 'io.netty:netty-codec-http', currentVersion: '4.1.94', fixedVersion: '4.1.108', application: 'Provider Directory API', status: 'remediated', discoveredDate: '2026-07-13' },
  { id: 'CVE-2024-25710', severity: 'MEDIUM', package: 'org.apache.commons:commons-compress', currentVersion: '1.24.0', fixedVersion: '1.26.0', application: 'Go365 Wellness Platform', status: 'open', discoveredDate: '2026-07-13' },
  { id: 'CVE-2024-47561', severity: 'CRITICAL', package: 'org.apache.avro:avro', currentVersion: '1.11.1', fixedVersion: '1.11.4', application: 'Claims Intake Integration Layer', status: 'open', discoveredDate: '2026-07-11' },
];

/**
 * Simulated ServiceNow SecOps tickets for vulnerability tracking
 */
const SERVICENOW_TICKETS = [
  { key: 'VULN-4821', cveId: 'CVE-2024-38816', status: 'New', assignee: 'Digital Experience Team', priority: 'Critical', createdDate: '2026-07-20' },
  { key: 'VULN-4822', cveId: 'CVE-2024-52316', status: 'New', assignee: 'Claims Platform Team', priority: 'Critical', createdDate: '2026-07-20' },
  { key: 'VULN-4823', cveId: 'CVE-2024-22262', status: 'New', assignee: 'Medicare Systems Team', priority: 'High', createdDate: '2026-07-18' },
  { key: 'VULN-4824', cveId: 'CVE-2024-47554', status: 'In Progress', assignee: 'CenterWell Engineering', priority: 'High', createdDate: '2026-07-18' },
  { key: 'VULN-4825', cveId: 'CVE-2024-29025', status: 'Closed Complete', assignee: 'Provider Data Team', priority: 'Medium', createdDate: '2026-07-13' },
  { key: 'VULN-4826', cveId: 'CVE-2024-25710', status: 'New', assignee: 'Go365 Platform Team', priority: 'Medium', createdDate: '2026-07-13' },
];

/**
 * Patch release schedule (CAB-approved change windows)
 */
const RELEASES = [
  { id: 'PATCH-2026-08', name: 'August Patch Window', date: '2026-08-12', status: 'planning', cveCount: 4 },
  { id: 'EXP-2026-07-C', name: 'Expedited Critical Release', date: '2026-07-29', status: 'approved', cveCount: 3 },
  { id: 'PATCH-2026-07', name: 'July Patch Window', date: '2026-07-15', status: 'deployed', cveCount: 7 },
];

/**
 * CVE remediation pipeline stages.
 * The pipeline config maps severity to its processing rules.
 * BUG: The "critical" severity has remediationConfig set to null
 * because critical CVEs bypass the standard CAB pipeline and go
 * directly to an expedited release. But the processRemediation
 * function unconditionally accesses .approvalWorkflow on the config,
 * crashing with TypeError.
 */
const PIPELINE_CONFIG = {
  critical: { maxDays: 15, releaseTrack: 'expedited', remediationConfig: null },
  high:     { maxDays: 30, releaseTrack: 'next-patch-window', remediationConfig: { approvalWorkflow: 'cab-standard', testSuite: 'regression', deployGate: 'change-advisory-board' } },
  medium:   { maxDays: 60, releaseTrack: 'next-patch-window', remediationConfig: { approvalWorkflow: 'cab-standard', testSuite: 'smoke', deployGate: 'auto' } },
  low:      { maxDays: 90, releaseTrack: 'next-patch-window', remediationConfig: { approvalWorkflow: 'cab-light', testSuite: 'unit', deployGate: 'auto' } },
};

/**
 * Resolve the pipeline config for a given severity.
 */
function resolvePipeline(severity) {
  const config = PIPELINE_CONFIG[severity.toLowerCase()];
  if (!config) return null;
  return { pipeline: config };
}

/**
 * Determine the approval workflow for a CVE remediation.
 * BUG: For "critical" severity, remediationConfig is null because critical
 * CVEs skip the standard CAB approval pipeline. Accessing .approvalWorkflow
 * on null crashes with TypeError.
 */
function determineApprovalWorkflow(pipelineData) {
  const workflow = pipelineData.pipeline.remediationConfig.approvalWorkflow;
  return workflow || 'expedited';
}

/**
 * Build the remediation plan for a CVE.
 */
function buildRemediationPlan(cveData, workflow) {
  return {
    planId: `REM-${Date.now()}`,
    cveId: cveData.cveId,
    severity: cveData.severity,
    package: cveData.package,
    currentVersion: cveData.currentVersion,
    fixedVersion: cveData.fixedVersion,
    application: cveData.application,
    approvalWorkflow: workflow,
    estimatedDeployDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    steps: [
      'Validate fix against HIPAA and CMS compliance requirements',
      'Update dependency version in build manifest',
      'Run integration test suite against member data sandbox',
      'Submit to Change Advisory Board',
      'Deploy via enterprise CI/CD pipeline',
    ],
  };
}

/**
 * Process a CVE remediation request.
 */
async function processRemediation(data) {
  const startTime = Date.now();
  const remediationId = uuidv4();

  logger.info('Processing CVE remediation', {
    remediationId,
    cveId: data.cveId,
    severity: data.severity,
    application: data.application,
    service: '7e6bb001-vms',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

    const pipelineData = resolvePipeline(data.severity);
    const workflow = determineApprovalWorkflow(pipelineData);
    const plan = buildRemediationPlan(data, workflow);

    const duration = Date.now() - startTime;

    incrementMetric('cve.remediation.success', {
      route: '/api/7e6bb001/remediate',
      severity: data.severity,
    });
    recordTiming('cve.remediation.latency', duration, {
      route: '/api/7e6bb001/remediate',
    });

    return {
      success: true,
      remediationId,
      plan,
      status: 'approved',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('cve.remediation.failure', {
      route: '/api/7e6bb001/remediate',
      errorClass: error.name,
      severity: data.severity,
    });
    recordTiming('cve.remediation.latency', duration, {
      route: '/api/7e6bb001/remediate',
      error: 'true',
    });

    logger.error('CVE remediation processing failed', {
      remediationId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      cveId: data.cveId,
      severity: data.severity,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/7e6bb001/remediate',
        service: '7e6bb001-vms',
        severity: data.severity,
      },
      extra: {
        remediationId,
        cveId: data.cveId,
        package: data.package,
        application: data.application,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/7e6bb001.js \u2014 determineApprovalWorkflow',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: '7e6bb001-vms',
      verticalLabel: 'CVE Remediation',
      customer: '7e6bb001',
      tags: [
        { key: 'route', value: '/api/7e6bb001/remediate' },
        { key: 'service', value: '7e6bb001-vms' },
        { key: 'severity', value: data.severity },
        { key: 'cveId', value: data.cveId },
      ],
      extra: { remediationId, cveId: data.cveId, package: data.package, application: data.application },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '7e6bb001-vms@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from CVE remediation error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRemediation, VULNERABILITIES, SERVICENOW_TICKETS, RELEASES };
