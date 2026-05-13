const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Security automation workflows for the demo
 */
const WORKFLOWS = [
  { id: 'WF-001', name: 'Phishing Email Triage', trigger: 'email_report', severity: 'high', steps: 6, lastRun: '2026-05-13T18:42:00Z', status: 'active' },
  { id: 'WF-002', name: 'Suspicious Login Enrichment', trigger: 'siem_alert', severity: 'critical', steps: 8, lastRun: '2026-05-13T19:15:00Z', status: 'active' },
  { id: 'WF-003', name: 'Malware Containment', trigger: 'edr_detection', severity: 'critical', steps: 12, lastRun: '2026-05-12T23:01:00Z', status: 'active' },
  { id: 'WF-004', name: 'Cloud IAM Anomaly Review', trigger: 'cspm_alert', severity: 'medium', steps: 5, lastRun: '2026-05-13T14:30:00Z', status: 'active' },
  { id: 'WF-005', name: 'Vulnerability Scan Dispatch', trigger: 'schedule', severity: 'low', steps: 4, lastRun: '2026-05-13T06:00:00Z', status: 'active' },
];

/**
 * Connected integrations for the demo
 */
const INTEGRATIONS = [
  { id: 'INT-01', name: 'CrowdStrike Falcon', category: 'EDR', status: 'connected', eventsToday: 1247 },
  { id: 'INT-02', name: 'Splunk SIEM', category: 'SIEM', status: 'connected', eventsToday: 8934 },
  { id: 'INT-03', name: 'Okta', category: 'Identity', status: 'connected', eventsToday: 562 },
  { id: 'INT-04', name: 'AWS Security Hub', category: 'CSPM', status: 'connected', eventsToday: 321 },
  { id: 'INT-05', name: 'ServiceNow', category: 'ITSM', status: 'connected', eventsToday: 89 },
  { id: 'INT-06', name: 'Slack', category: 'Communication', status: 'connected', eventsToday: 204 },
];

/**
 * Recent security events for the demo
 */
const EVENTS = [
  { id: 'EVT-4401', type: 'phishing_report', source: 'Email Gateway', summary: 'Suspicious attachment in email from external sender', severity: 'high', timestamp: '2026-05-13T19:22:00Z' },
  { id: 'EVT-4402', type: 'siem_alert', source: 'Splunk SIEM', summary: 'Brute-force login attempts detected — 48 failures in 2 min', severity: 'critical', timestamp: '2026-05-13T19:18:00Z' },
  { id: 'EVT-4403', type: 'edr_detection', source: 'CrowdStrike', summary: 'Cobalt Strike beacon detected on endpoint WS-DEV-0142', severity: 'critical', timestamp: '2026-05-13T19:12:00Z' },
  { id: 'EVT-4404', type: 'cspm_alert', source: 'AWS Security Hub', summary: 'S3 bucket policy changed to allow public read access', severity: 'medium', timestamp: '2026-05-13T18:55:00Z' },
];

/**
 * Workflow step definitions — each workflow has a sequence of automated actions.
 * The step config maps workflow triggers to their action pipelines.
 */
const WORKFLOW_STEPS = {
  email_report: [
    { action: 'extract_indicators', integration: 'email-gateway' },
    { action: 'lookup_threat_intel', integration: 'virustotal' },
    { action: 'check_sender_reputation', integration: 'proofpoint' },
    { action: 'quarantine_email', integration: 'exchange' },
    { action: 'create_case', integration: 'servicenow' },
    { action: 'notify_soc', integration: 'slack' },
  ],
  siem_alert: [
    { action: 'enrich_ip', integration: 'threat-intel' },
    { action: 'query_user_activity', integration: 'okta' },
    { action: 'check_geo_anomaly', integration: 'maxmind' },
    { action: 'correlate_events', integration: 'splunk' },
    { action: 'assess_risk_score', integration: 'risk-engine' },
    { action: 'block_ip', integration: 'firewall' },
    { action: 'disable_account', integration: 'active-directory' },
    { action: 'create_incident', integration: 'servicenow' },
  ],
  edr_detection: null,
  cspm_alert: [
    { action: 'get_resource_details', integration: 'aws' },
    { action: 'revert_policy', integration: 'aws' },
    { action: 'scan_access_logs', integration: 'cloudtrail' },
    { action: 'create_finding', integration: 'security-hub' },
    { action: 'notify_team', integration: 'slack' },
  ],
  schedule: [
    { action: 'list_assets', integration: 'cmdb' },
    { action: 'run_scan', integration: 'qualys' },
    { action: 'parse_results', integration: 'internal' },
    { action: 'file_tickets', integration: 'jira' },
  ],
};

/**
 * Resolve the execution pipeline for a given workflow trigger.
 */
function getExecutionPipeline(triggerType) {
  const pipeline = WORKFLOW_STEPS[triggerType];
  return pipeline;
}

/**
 * Build the enrichment context by fetching threat data for the event.
 */
function buildEnrichmentContext(event) {
  const enrichment = {
    eventId: event.id,
    indicators: [],
    riskScore: null,
  };

  const indicators = event.indicators;
  enrichment.indicators = indicators.map((i) => ({
    type: i.type,
    value: i.value,
    malicious: i.score > 70,
  }));

  return enrichment;
}

/**
 * Execute a security automation workflow.
 */
async function executeWorkflow(data) {
  const startTime = Date.now();
  const executionId = uuidv4();

  logger.info('Executing security workflow', {
    executionId,
    workflowId: data.workflowId,
    eventId: data.eventId,
    service: 'torq-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const workflow = WORKFLOWS.find((w) => w.id === data.workflowId);
    const event = EVENTS.find((e) => e.id === data.eventId);

    const pipeline = getExecutionPipeline(workflow.trigger);
    const enrichment = buildEnrichmentContext(event);

    const stepsCompleted = pipeline.length;

    const duration = Date.now() - startTime;

    incrementMetric('workflow.execution.success', {
      route: '/api/torq/execute',
      workflowId: data.workflowId,
    });
    recordTiming('workflow.execution.latency', duration, {
      route: '/api/torq/execute',
    });

    return {
      success: true,
      executionId,
      workflowId: data.workflowId,
      workflowName: workflow.name,
      eventId: data.eventId,
      stepsCompleted,
      enrichment,
      status: 'completed',
      executedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('workflow.execution.failure', {
      route: '/api/torq/execute',
      errorClass: error.name,
    });
    recordTiming('workflow.execution.latency', duration, {
      route: '/api/torq/execute',
      error: 'true',
    });

    logger.error('Workflow execution failed', {
      executionId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      workflowId: data.workflowId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/torq/execute',
        service: 'torq-api',
        workflowId: data.workflowId,
      },
      extra: { executionId, workflowId: data.workflowId, eventId: data.eventId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/torq.js — executeWorkflow',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'torq-api',
      verticalLabel: 'Workflow Execution',
      tags: [
        { key: 'route', value: '/api/torq/execute' },
        { key: 'service', value: 'torq-api' },
      ],
      extra: { executionId, workflowId: data.workflowId, eventId: data.eventId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'torq@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from workflow error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { executeWorkflow, WORKFLOWS, INTEGRATIONS, EVENTS };
