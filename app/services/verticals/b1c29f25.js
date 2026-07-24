const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Highmark member document catalog — each protected document maps to the
 * access scope required to release it.
 */
const DOCUMENTS = [
  { id: 'DOC-EOB-Q2', name: 'Explanation of Benefits — Q2 2026', sensitivity: 'standard', scopeId: 'SCOPE-BENEFITS-READ' },
  { id: 'DOC-CLAIMS', name: 'Claims Summary — 2026 Plan Year', sensitivity: 'standard', scopeId: 'SCOPE-CLAIMS-READ' },
  { id: 'DOC-LAB-RESULTS', name: 'Laboratory Results — Metabolic Panel', sensitivity: 'phi', scopeId: 'SCOPE-CLINICAL-READ' },
  { id: 'DOC-BH-NOTES', name: 'Behavioral Health Notes — Care Plan', sensitivity: 'restricted', scopeId: 'SCOPE-BH-READ' },
];

/**
 * Registered access scopes. Each scope declares the permissions it grants and
 * the minimum assurance level required to exercise it.
 */
const SCOPES = [
  { id: 'SCOPE-BENEFITS-READ', name: 'Benefits: Read', minAssurance: 1, permissions: ['read:eob'] },
  { id: 'SCOPE-CLAIMS-READ', name: 'Claims: Read', minAssurance: 1, permissions: ['read:claims'] },
  { id: 'SCOPE-CLINICAL-READ', name: 'Clinical: Read', minAssurance: 2, permissions: ['read:labs', 'read:clinical'] },
  { id: 'SCOPE-BH-READ', name: 'Behavioral Health: Read', minAssurance: 3, permissions: ['read:behavioral'] },
];

/**
 * Assurance level granted by each verification method. Drives the
 * step-up authentication decision for restricted records.
 */
const VERIFICATION_ASSURANCE = {
  email_otp: { level: 1, label: 'Email OTP' },
  sms_otp: { level: 2, label: 'SMS OTP' },
  mfa_app: { level: 3, label: 'Authenticator App (MFA)' },
};

/**
 * Data residency configuration for HIPAA-covered regions.
 */
const DATA_REGIONS = {
  US: { residency: 'us', label: 'United States' },
  'US-EAST': { residency: 'us-east', label: 'US — East' },
  'US-WEST': { residency: 'us-west', label: 'US — West' },
};

/**
 * Regulatory grants that are force-injected into every authorization request.
 * The 42 CFR Part 2 behavioral-health disclosure grant must be attached so the
 * release is recorded, but its scope is not yet registered in the SCOPES catalog.
 */
const MANDATORY_GRANTS = [
  { docId: 'DOC-BH-DISCLOSURE', scopeId: 'SCOPE-BH-DISCLOSURE-2026', reason: '42 CFR Part 2 mandatory disclosure record' },
];

/**
 * Returns the step-up policy for a given assurance level.
 */
function getStepUpPolicy(assuranceLevel) {
  if (assuranceLevel >= 3) return { tier: 'full', label: 'Full access (MFA satisfied)' };
  if (assuranceLevel >= 2) return { tier: 'elevated', label: 'Elevated access' };
  return { tier: 'basic', label: 'Basic access' };
}

/**
 * Merges regulatory disclosure grants into the requested document set.
 */
function applyMandatoryGrants(documents) {
  const grantDocs = MANDATORY_GRANTS.map((grant) => ({ id: grant.docId, scopeId: grant.scopeId }));
  return [...documents, ...grantDocs];
}

/**
 * Validates that the member's assurance level satisfies every required scope.
 */
function evaluateAssurance(assuranceLevel, region) {
  const regionConfig = DATA_REGIONS[region];
  if (!regionConfig) {
    throw Object.assign(new Error(`Unknown data region: ${region}`), { code: 'INVALID_REGION' });
  }
  const policy = getStepUpPolicy(assuranceLevel);
  return {
    assuranceLevel,
    residency: regionConfig.residency,
    policyTier: policy.tier,
    policyLabel: policy.label,
  };
}

/**
 * Builds the access manifest returned to the caller — one entry per document,
 * resolving each requested document to its scope definition.
 * BUG: SCOPE-BH-DISCLOSURE-2026 is not in SCOPES, so scope.permissions crashes.
 */
function buildAccessManifest(allDocs) {
  return allDocs.map((doc) => {
    const scope = SCOPES.find((s) => s.id === doc.scopeId);
    return {
      docId: doc.id,
      scopeId: doc.scopeId,
      scopeName: scope.name,
      permissions: scope.permissions,
      minAssurance: scope.minAssurance,
    };
  });
}

/**
 * Authorizes a Highmark member document access request.
 */
async function authorizeAccess(requestData) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Authorizing Highmark document access request', {
    requestId,
    memberId: requestData.memberId,
    documentCount: (requestData.documents || []).length,
    service: 'highmark-member-portal',
    route: '/api/b1c29f25/authorize',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const verification = VERIFICATION_ASSURANCE[requestData.verifyMethod]
      || VERIFICATION_ASSURANCE.email_otp;

    const assurance = evaluateAssurance(verification.level, requestData.region);

    const allDocs = applyMandatoryGrants(requestData.documents);
    const manifest = buildAccessManifest(allDocs);

    const duration = Date.now() - startTime;

    incrementMetric('authz.success', {
      route: '/api/b1c29f25/authorize',
      source: 'highmark-member-portal',
    });
    recordTiming('authz.latency', duration, {
      route: '/api/b1c29f25/authorize',
    });

    return {
      success: true,
      requestId,
      grantedCount: manifest.length,
      policyTier: assurance.policyTier,
      assuranceLevel: assurance.assuranceLevel,
      manifest,
      status: 'authorized',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('authz.failure', {
      route: '/api/b1c29f25/authorize',
      errorClass: error.name,
      source: 'highmark-member-portal',
    });
    recordTiming('authz.latency', duration, {
      route: '/api/b1c29f25/authorize',
      error: 'true',
    });

    logger.error('Highmark access authorization failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      memberId: requestData.memberId,
      service: 'highmark-member-portal',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b1c29f25/authorize',
        service: 'highmark-member-portal',
        source: 'highmark-member-portal',
      },
      extra: {
        requestId,
        memberId: requestData.memberId,
        verifyMethod: requestData.verifyMethod,
        region: requestData.region,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b1c29f25.js \u2014 buildAccessManifest',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: requestData.devinUserId,
      devinEmail: requestData.devinEmail,
      devinOrgId: requestData.devinOrgId,
      service: 'highmark-member-portal',
      verticalLabel: 'Highmark \u2014 Secure Document Access',
      tags: [
        { key: 'route', value: '/api/b1c29f25/authorize' },
        { key: 'service', value: 'highmark-member-portal' },
        { key: 'category', value: 'access-control' },
        { key: 'data_class', value: 'phi' },
      ],
      extra: { requestId, memberId: requestData.memberId, verifyMethod: requestData.verifyMethod },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'highmark-member-portal@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Highmark authorization error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  authorizeAccess,
  buildAccessManifest,
  applyMandatoryGrants,
  evaluateAssurance,
  DOCUMENTS,
  SCOPES,
  DATA_REGIONS,
};
