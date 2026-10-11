const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/d60dcff1/review/approve';
const SERVICE = 'customer-intake-review-approve';

const REVIEW_DOCUMENT = {
  documentId: 'doc-7f3a91c2',
  docType: 'tod_registration',
  docTypeLabel: 'TOD Registration Request',
  configVersion: 'tod_registration@v4',
  sender: 'Shah Family Trust',
  fields: {
    owner_name: 'Priya N. Shah',
    account_number: '50917-2214',
    beneficiaries: [
      { name: 'Arjun Shah', relationship: 'Son', allocationPct: 60 },
      { name: 'Meera Shah', relationship: 'Daughter', allocationPct: 40 },
    ],
    signature_present: true,
    signature_date: '09/28/2026',
  },
};

/**
 * Doc type configs, keyed by immutable config version. Approval routes the
 * reviewed document to the outbox using its config version's allocation policy
 * (how beneficiary percentages are rounded and what they must total).
 */
const DOC_TYPE_CONFIGS = {
  'tod_registration@v3': {
    docType: 'tod_registration',
    outboxTopic: 'registrations.tod.approved',
    allocationPolicy: { roundingMode: 'half-even', precision: 2, requiredTotal: 100 },
  },
  'tod_registration@v4': {
    docType: 'tod_registration',
    outboxTopic: 'registrations.tod.approved',
    publishedAt: '2026-10-09',
    requiredFields: ['owner_name', 'account_number', 'beneficiaries', 'signature_present', 'signature_date'],
  },
};

const INTAKE_SLACK_MEMBER_ID = process.env.INTAKE_SLACK_MEMBER_ID || '';
const INTAKE_DEVIN_USER_ID = process.env.DEVIN_USER_ID_D60DCFF1 || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved precision';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the document review approval failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST ${ROUTE}, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the review console at app/public/verticals/d60dcff1.html (served at /d60dcff1), whose "Approve" button posts to POST ${ROUTE} in app/routes/verticals/d60dcff1.js. The approval pipeline lives in app/services/verticals/d60dcff1.js: approveDocument -> buildOutboxEvent -> normalizeAllocations -> applyAllocationPolicy. Start at buildOutboxEvent: it looks up DOC_TYPE_CONFIGS by the document's config version, and the newly published tod_registration@v4 config was published without an allocationPolicy, so applyAllocationPolicy dereferences undefined. Give tod_registration@v4 the same allocation policy as tod_registration@v3, and make a config version without an allocation policy fail as a handled "This document type's configuration is incomplete" error (HTTP 409, no alert) instead of a TypeError. Do not change the page's look and feel and do not touch other verticals. Verify by starting the server (node app/server.js) and POSTing {"documentId":"doc-7f3a91c2","configVersion":"tod_registration@v4","reviewer":"admin@demo"} to ${ROUTE}, which must return an approved outbox event with allocations totalling 100, and confirm npm run lint passes.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file and before proposing a cause, is to start the server (node app/server.js), open /d60dcff1?repro=1 in a real browser, click "Upload & extract", then "Open in review", then "Approve", with your screen recording, so the recording shows the review console, the click and the error. Always use ?repro=1 for your own submissions: the approval fails identically but raises no Sentry event, Slack alert or Devin session. If it does not reproduce, stop and report that instead of fixing anything.

Verification evidence is mandatory and must be visual, not curl-only: after the fix, repeat the same /d60dcff1?repro=1 browser flow with a second screen recording showing "Approved — released to the outbox" where the error used to be. Attach both recordings (as animated webp) under "Reproduction" and "Fix Verification" headings to the pull request.`;

function validationError(message, code = 'INVALID_REVIEW') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function applyAllocationPolicy(beneficiaries, policy) {
  const factor = 10 ** policy.precision;
  const allocations = beneficiaries.map((b) => ({
    name: b.name,
    relationship: b.relationship,
    allocationPct: Math.round(b.allocationPct * factor) / factor,
  }));
  const total = allocations.reduce((sum, a) => sum + a.allocationPct, 0);
  if (Math.abs(total - policy.requiredTotal) > 1 / factor) {
    throw validationError(`Beneficiary allocations total ${total}%, expected ${policy.requiredTotal}%`, 'ALLOCATION_TOTAL');
  }
  return { allocations, total, roundingMode: policy.roundingMode };
}

function normalizeAllocations(fields, config) {
  return applyAllocationPolicy(fields.beneficiaries || [], config.allocationPolicy);
}

function buildOutboxEvent(document, reviewer) {
  const config = DOC_TYPE_CONFIGS[document.configVersion];
  const allocation = normalizeAllocations(document.fields, config);
  return {
    topic: config.outboxTopic,
    documentId: document.documentId,
    configVersion: document.configVersion,
    owner: document.fields.owner_name,
    accountNumber: document.fields.account_number,
    beneficiaries: allocation.allocations,
    allocationTotal: allocation.total,
    approvedBy: reviewer,
    approvedAt: new Date().toISOString(),
  };
}

async function approveDocument(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  if (data.documentId !== REVIEW_DOCUMENT.documentId) throw validationError(`Unknown document: ${data.documentId || '(none)'}`, 'UNKNOWN_DOCUMENT');
  if (!Object.hasOwn(DOC_TYPE_CONFIGS, String(data.configVersion))) throw validationError(`Unknown config version: ${data.configVersion || '(none)'}`, 'UNKNOWN_CONFIG');
  const reviewer = typeof data.reviewer === 'string' && data.reviewer.trim() ? data.reviewer.trim() : 'admin@demo';
  const document = { ...REVIEW_DOCUMENT, configVersion: data.configVersion };

  logger.info('Approving reviewed document', {
    requestId,
    documentId: document.documentId,
    configVersion: document.configVersion,
    docType: document.docType,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const event = buildOutboxEvent(document, reviewer);
    const duration = Date.now() - startTime;
    incrementMetric('intake_review_approve.success', { route: ROUTE, configVersion: document.configVersion });
    recordTiming('intake_review_approve.latency', duration, { route: ROUTE });
    return { success: true, status: 'approved', outboxEvent: event, requestId };
  } catch (error) {
    const duration = Date.now() - startTime;
    if (error.statusCode === 400) {
      error.requestId = requestId;
      throw error;
    }

    incrementMetric('intake_review_approve.failure', { route: ROUTE, errorClass: error.name, configVersion: document.configVersion });
    recordTiming('intake_review_approve.latency', duration, { route: ROUTE, error: 'true' });

    const context = {
      requestId,
      documentId: document.documentId,
      docType: document.docType,
      configVersion: document.configVersion,
      reviewer,
      beneficiaryCount: document.fields.beneficiaries.length,
    };

    logger.error('Document review approval failed', {
      ...context,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (data.synthetic) {
      logger.info('Reproduction run — approval failed without raising Sentry, Slack or a Devin session', { requestId, route: ROUTE });
      error.requestId = requestId;
      throw error;
    }

    const tags = { route: ROUTE, service: SERVICE, docType: document.docType, configVersion: document.configVersion };

    Sentry.captureException(error, { tags, extra: context });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/d60dcff1.js — applyAllocationPolicy',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: 'Intake Factory — Review console approval',
      customer: 'd60dcff1',
      slackMemberId: data.devinEmail ? '' : INTAKE_SLACK_MEMBER_ID,
      slackMemberIdFallback: INTAKE_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId || INTAKE_DEVIN_USER_ID,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      extra: context,
      level: 'error',
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
      logger.error('Failed to create Devin session for document review approval error', { requestId, error: alertError.message });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  approveDocument,
  buildOutboxEvent,
  normalizeAllocations,
  applyAllocationPolicy,
  DOC_TYPE_CONFIGS,
  REVIEW_DOCUMENT,
  REMEDIATION_DIRECTIVE,
};
