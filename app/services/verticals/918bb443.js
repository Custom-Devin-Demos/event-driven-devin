const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = '918bb443-api';
const ROUTE = '/api/918bb443/templates/upload';

/**
 * House template library — every client upload must resolve to one of these
 * before its columns can be mapped onto the client data model.
 */
const TEMPLATE_LIBRARY = [
  {
    templateId: 'TPL-PRB-0312',
    name: 'PR Campaign Brief',
    revision: '3.2',
    practice: 'PR and Corporate Communications',
    owner: 'PR Practice',
    columns: [
      { label: 'Client Name', field: 'client.account_name', type: 'string', required: true },
      { label: 'Campaign Name', field: 'campaign.name', type: 'string', required: true },
      { label: 'Campaign Objective', field: 'campaign.objective', type: 'enum', required: true },
      { label: 'Key Messages', field: 'campaign.key_messages', type: 'text', required: true },
      { label: 'Primary Audience', field: 'audience.primary_segment', type: 'string', required: true },
      { label: 'Spokesperson', field: 'stakeholder.spokesperson', type: 'string', required: false },
      { label: 'Embargo Date', field: 'schedule.embargo_at', type: 'date', required: true },
      { label: 'Target Publications', field: 'media.target_outlets', type: 'list', required: false },
      { label: 'Budget (GBP)', field: 'finance.budget_gbp', type: 'currency', required: true },
      { label: 'Approval Contact', field: 'governance.approver_email', type: 'email', required: true },
    ],
  },
  {
    templateId: 'TPL-EMT-0207',
    name: 'Earned Media Coverage Tracker',
    revision: '2.7',
    practice: 'PR and Corporate Communications',
    owner: 'PR Practice',
    columns: [
      { label: 'Outlet', field: 'media.outlet_name', type: 'string', required: true },
      { label: 'Journalist', field: 'media.journalist', type: 'string', required: false },
      { label: 'Publish Date', field: 'coverage.published_at', type: 'date', required: true },
      { label: 'Headline', field: 'coverage.headline', type: 'string', required: true },
      { label: 'Sentiment', field: 'coverage.sentiment', type: 'enum', required: true },
      { label: 'Reach', field: 'coverage.estimated_reach', type: 'integer', required: false },
    ],
  },
  {
    templateId: 'TPL-CCQ-0104',
    name: 'Crisis Comms Q&A Pack',
    revision: '1.4',
    practice: 'PR and Corporate Communications',
    owner: 'Central Templates',
    columns: [
      { label: 'Question', field: 'qa.question', type: 'text', required: true },
      { label: 'Holding Statement', field: 'qa.holding_statement', type: 'text', required: true },
      { label: 'Owner', field: 'stakeholder.owner', type: 'string', required: true },
      { label: 'Legal Sign-off', field: 'governance.legal_signoff', type: 'boolean', required: true },
      { label: 'Channel', field: 'distribution.channel', type: 'enum', required: false },
    ],
  },
  {
    templateId: 'TPL-MPI-0501',
    name: 'Media Plan Intake',
    revision: '5.1',
    practice: 'Media',
    owner: 'Media Practice',
    columns: [
      { label: 'Advertiser', field: 'client.account_name', type: 'string', required: true },
      { label: 'Flight Start', field: 'schedule.flight_start', type: 'date', required: true },
      { label: 'Flight End', field: 'schedule.flight_end', type: 'date', required: true },
      { label: 'Channel Mix', field: 'media.channel_mix', type: 'list', required: true },
      { label: 'KPI', field: 'campaign.primary_kpi', type: 'enum', required: true },
      { label: 'Net Budget (GBP)', field: 'finance.budget_gbp', type: 'currency', required: true },
    ],
  },
];

/**
 * The client workbook already staged in the workspace, awaiting upload.
 */
const STAGED_TEMPLATE = {
  uploadId: 'UPL-2026-09-4471',
  fileName: 'Nespresso_UK_Q4_Press_Launch_Brief.xlsx',
  fileSize: '184 KB',
  stagedBy: 'Charlotte Hughes',
  stagedAt: '2026-09-30T09:12:00Z',
  client: 'Nespresso UK',
  workflow: 'Q4 Vertuo Launch — Press Office',
  sheet: {
    name: 'Brief',
    columns: [
      { header: 'Client Name', sample: 'Nespresso UK' },
      { header: 'Campaign Name', sample: 'Vertuo Pop+ Autumn Launch' },
      { header: 'Campaign Objective', sample: 'Awareness' },
      { header: 'Key Messages', sample: 'Barista-grade coffee at home; 100% recyclable aluminium capsules' },
      { header: 'Primary Audience', sample: 'Urban professionals 25–40' },
      { header: 'Spokesperson', sample: 'Head of Coffee, Nespresso UK' },
      { header: 'Embargo Date', sample: '2026-10-14' },
      { header: 'Target Publications', sample: 'The Guardian; Evening Standard; Stylist; GQ' },
      { header: 'Budget (GBP)', sample: '85000' },
      { header: 'Approval Contact', sample: 'press.approvals@nespresso-uk.example' },
    ],
    rowCount: 42,
  },
};

function fingerprintColumns(labels) {
  return labels
    .map((label) => String(label).trim().toLowerCase())
    .sort()
    .join('|');
}

const LIBRARY_INDEX = new Map(
  TEMPLATE_LIBRARY.map((tpl) => [fingerprintColumns(tpl.columns.map((c) => c.label)), tpl]),
);

function identifyTemplate(headers) {
  return LIBRARY_INDEX.get(fingerprintColumns(headers));
}

function buildColumnMappings(template, headers) {
  return template.columns.map((col) => {
    const index = headers.indexOf(col.label);
    return {
      column: col.label,
      sourceIndex: index,
      targetField: col.field,
      type: col.type,
      required: col.required,
      status: index >= 0 ? 'mapped' : 'missing',
    };
  });
}

function validateMappings(mappings) {
  const missingRequired = mappings.filter((m) => m.required && m.status === 'missing');
  return {
    mapped: mappings.filter((m) => m.status === 'mapped').length,
    total: mappings.length,
    missingRequired: missingRequired.map((m) => m.column),
    passed: missingRequired.length === 0,
  };
}

function formatUploadResult(upload, template, mappings, validation) {
  return {
    uploadId: upload.uploadId,
    fileName: upload.fileName,
    template: {
      templateId: template.templateId,
      name: template.name,
      revision: template.revision,
      owner: template.owner,
    },
    mappings,
    validation,
    workflowStatus: validation.passed ? 'ready_for_workflow' : 'needs_attention',
    processedAt: new Date().toISOString(),
  };
}

/**
 * Upload a staged client workbook: identify its library template, map its
 * columns onto the client data model and validate required fields.
 */
async function processTemplateUpload(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing template upload', {
    requestId,
    uploadId: data.upload.uploadId,
    fileName: data.upload.fileName,
    columnCount: data.headers.length,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const template = identifyTemplate(data.headers);
    const mappings = buildColumnMappings(template, data.headers);
    const validation = validateMappings(mappings);
    const result = formatUploadResult(data.upload, template, mappings, validation);

    incrementMetric('template_upload.success', { route: ROUTE, templateId: template.templateId });
    recordTiming('template_upload.latency', Date.now() - startTime, { route: ROUTE });

    return { success: true, requestId, result };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('template_upload.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('template_upload.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Template upload failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      uploadId: data.upload.uploadId,
      fileName: data.upload.fileName,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE },
      extra: {
        requestId,
        uploadId: data.upload.uploadId,
        fileName: data.upload.fileName,
        headers: data.headers,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/918bb443.js — processTemplateUpload',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Client Template Upload',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'page', value: '/918bb443' },
      ],
      promptAppendix: 'The user-facing page that triggered this error is /918bb443 — after fixing, verify end-to-end that clicking "Upload template" on /918bb443 completes every check and shows the column mappings.',
      extra: {
        requestId,
        uploadId: data.upload.uploadId,
        fileName: data.upload.fileName,
        headers: data.headers,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '918bb443@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processTemplateUpload, TEMPLATE_LIBRARY, STAGED_TEMPLATE };
