const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/dc2379a5/trust-center/access-requests';
const SERVICE = 'customer-dc2379a5-trust-center-access';
const SLACK_MEMBER_ID_FALLBACK = process.env.VANTA_SLACK_MEMBER_ID || '';
const DAY_MS = 24 * 60 * 60 * 1000;

const FREE_EMAIL_DOMAINS = ['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com', 'proton.me'];

const TRUST_DOCUMENTS = {
  'soc2-type2-report': { title: 'SOC 2 Type II Report', framework: 'soc2' },
  'soc2-bridge-letter': { title: 'SOC 2 Bridge Letter', framework: 'soc2' },
  'iso27001-certificate': { title: 'ISO 27001 Certificate', framework: 'iso27001' },
  'iso27001-soa': { title: 'ISO 27001 Statement of Applicability', framework: 'iso27001' },
  'iso42001-certificate': { title: 'ISO 42001 Certificate', framework: 'iso42001' },
  'hipaa-attestation': { title: 'HIPAA Attestation Report', framework: 'hipaa' },
  'pentest-summary': { title: 'Penetration Test Summary', framework: 'pentest' },
};

const FRAMEWORK_ACCESS_POLICIES = {
  soc2: { label: 'SOC 2 Type II', ndaTemplate: 'vanta-mnda-2026', autoApprove: true, accessDays: 90 },
  iso27001: { label: 'ISO 27001:2022', ndaTemplate: 'vanta-mnda-2026', autoApprove: true, accessDays: 90 },
  'iso-42001': { label: 'ISO 42001:2023', ndaTemplate: 'vanta-mnda-2026', autoApprove: true, accessDays: 90 },
  hipaa: { label: 'HIPAA', ndaTemplate: 'vanta-mnda-2026-baa', autoApprove: false, accessDays: 30 },
  pentest: { label: 'Penetration Test', ndaTemplate: 'vanta-mnda-2026', autoApprove: false, accessDays: 30 },
};

const REMEDIATION_DIRECTIVE = `
## Remediation directive (Vanta Trust Center access requests)
- The failing request is POST ${ROUTE} with the ISO 42001 Certificate selected.
- Trace how each requested document resolves to its framework access policy in app/services/verticals/dc2379a5.js (\`buildAccessGrants\`, \`FRAMEWORK_ACCESS_POLICIES\`, \`TRUST_DOCUMENTS\`) and fix the root cause so every document in \`TRUST_DOCUMENTS\` resolves to a policy.
- Keep SOC 2, ISO 27001, HIPAA and penetration test grants behaving exactly as they do today, including manual review for HIPAA and penetration test documents.
- Add a regression test in tests/dc2379a5-trust-center-access.test.js that requests the ISO 42001 Certificate and expects an approved grant.
`;

class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.statusCode = 400;
  }
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeRequest(data) {
  const fullName = text(data.fullName, 120);
  if (!fullName) throw new ValidationError('Full name is required.', 'INVALID_NAME');

  const workEmail = text(data.workEmail, 200).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(workEmail)) {
    throw new ValidationError('Enter a valid work email address.', 'INVALID_EMAIL');
  }
  if (FREE_EMAIL_DOMAINS.includes(workEmail.split('@')[1])) {
    throw new ValidationError('Use your company email address to request access.', 'WORK_EMAIL_REQUIRED');
  }

  const company = text(data.company, 120);
  if (!company) throw new ValidationError('Company is required.', 'INVALID_COMPANY');

  if (!Array.isArray(data.documents) || data.documents.length === 0) {
    throw new ValidationError('Select at least one document.', 'INVALID_DOCUMENTS');
  }
  const documents = [...new Set(data.documents.map((id) => String(id).trim()))];
  const unknown = documents.find((id) => !TRUST_DOCUMENTS[id]);
  if (unknown) throw new ValidationError(`Unknown document "${unknown}".`, 'INVALID_DOCUMENTS');

  if (data.ndaAccepted !== true) {
    throw new ValidationError('Accept the mutual NDA to request restricted documents.', 'NDA_REQUIRED');
  }

  return { fullName, workEmail, company, reason: text(data.reason, 500), documents };
}

function buildAccessGrants(documentIds, now = Date.now()) {
  return documentIds.map((documentId) => {
    const document = TRUST_DOCUMENTS[documentId];
    const policy = FRAMEWORK_ACCESS_POLICIES[document.framework];
    return {
      documentId,
      title: document.title,
      ndaTemplate: policy.ndaTemplate,
      framework: policy.label,
      status: policy.autoApprove ? 'approved' : 'pending_review',
      expiresAt: policy.autoApprove ? new Date(now + policy.accessDays * DAY_MS).toISOString() : null,
    };
  });
}

async function requestTrustCenterAccess(data) {
  const startTime = Date.now();
  const requestId = `VTR-${uuidv4().slice(0, 8).toUpperCase()}`;
  const request = normalizeRequest(data);
  const documentTag = request.documents.join('|');

  logger.info('Vanta Trust Center access request', {
    requestId,
    documents: request.documents,
    emailDomain: request.workEmail.split('@')[1],
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const grants = buildAccessGrants(request.documents, startTime);
    const pendingReview = grants.some((grant) => grant.status === 'pending_review');
    const duration = Date.now() - startTime;

    incrementMetric('trust_center_access.success', { route: ROUTE, documents: documentTag });
    recordTiming('trust_center_access.latency', duration, { route: ROUTE });

    return {
      success: true,
      requestId,
      status: pendingReview ? 'pending_review' : 'approved',
      deliveredTo: request.workEmail,
      company: request.company,
      grants,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('trust_center_access.failure', {
      route: ROUTE,
      documents: documentTag,
      errorClass: error.name,
    });
    recordTiming('trust_center_access.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Vanta Trust Center access request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      documents: request.documents,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, documents: documentTag },
      extra: { requestId, documents: request.documents, company: request.company },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/dc2379a5.js — buildAccessGrants',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Vanta Trust Center',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'dc2379a5',
      slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'documents', value: documentTag },
      ],
      extra: { requestId, documents: request.documents, company: request.company },
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
      logger.error('Failed to create Devin session for Vanta Trust Center access error', {
        error: alertError.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  requestTrustCenterAccess,
  normalizeRequest,
  buildAccessGrants,
  TRUST_DOCUMENTS,
  FRAMEWORK_ACCESS_POLICIES,
  REMEDIATION_DIRECTIVE,
};
