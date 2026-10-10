const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'enforcement-intake-api';

// Executive instruments on file for the signed-in applicant. Each is verified
// with its issuing registry before the enforcement request is accepted.
const INSTRUMENTS = {
  'JDG-4470099812': {
    id: 'JDG-4470099812',
    type: 'judgment',
    label: 'حكم قضائي — المحكمة العامة بالرياض',
    issuer: 'court',
  },
  'PN-2291': {
    id: 'PN-2291',
    type: 'promissory_note',
    label: 'سند لأمر إلكتروني',
    issuer: 'promissory-registry',
  },
  'NC-7713': {
    id: 'NC-7713',
    type: 'notarized_contract',
    label: 'عقد موثق',
    issuer: 'notary-registry',
  },
};

const REQUEST_TYPES = {
  financial: 'مالي',
  direct: 'تنفيذ مباشر',
  personal_status: 'أحوال شخصية',
};

/**
 * One tenant per demo owner. Each tenant files its court judgments through its
 * own court circuit, so changing how one tenant's circuit is verified leaves
 * every other tenant's submissions behaving as before.
 *
 * There is deliberately no shared or default tenant: the vertical is reachable
 * only at /7d5b6457/<slug>, so nobody lands on someone else's demo. Add an
 * owner by adding an entry here with an unused court circuit.
 */
const TENANTS = {
  nouf: {
    slug: 'nouf',
    label: 'Najiz — Enforcement Request (Nouf)',
    applicant: {
      fullName: 'نورة الحربي',
      nationalIdMasked: '••••••2271',
    },
    courtCircuit: 'riyadh-general-nouf',
  },
};

function getTenant(slug) {
  const key = String(slug || '').trim().toLowerCase();
  return Object.hasOwn(TENANTS, key) ? TENANTS[key] : undefined;
}

// Instrument registry API versions.
const REGISTRY_ENDPOINTS = {
  'v1/instruments/verify-sync': { latencyMs: [3600, 4500], deprecated: true },
  'v2/instruments/verify': { latencyMs: [180, 340], deprecated: false },
};

// Registry circuits served by the v2 verification API.
const VERIFICATION_ROUTES = {
  'promissory-registry': 'v2/instruments/verify',
  'notary-registry': 'v2/instruments/verify',
};

const DEFAULT_VERIFICATION_ENDPOINT = 'v1/instruments/verify-sync';
const VERIFICATION_TIMEOUT_MS = 2500;
const VERIFICATION_ATTEMPTS = 3;
const MAX_CLAIM_AMOUNT = 100000000;

const SLACK_MEMBER_ID = process.env.SLACK_MEMBER_ID_7D5B6457 || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved "Instrument verification timed out"';

// Replaceable in tests so the registry latency does not slow the suite down.
const clock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the enforcement-request failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues; ignore every issue that is not from the route named in the alert's route tag and do not modify any other vertical or any shared module. The failing surface is the enforcement-request page at app/public/verticals/7d5b6457.html, served per demo owner at GET /7d5b6457/<tenant>, whose "تقديم الطلب" action posts to POST /api/7d5b6457/<tenant>/enforcement-requests in app/routes/verticals/7d5b6457.js. The submission pipeline lives in app/services/verticals/7d5b6457.js: submitEnforcementRequest -> verifyInstrument -> callRegistry. Every submission for the affected instrument hangs for several seconds and then fails with a 504; diagnose the cause from the service's logs and the alert's tags rather than guessing. Use the circuit named in the alert's circuit tag as the remediation target and leave every other tenant's circuit untouched. Keep a genuine registry timeout surfacing as a handled 504 GatewayTimeoutError. Verify by starting the server (node app/server.js) and submitting the affected tenant's request, which must return a request number in well under a second, and confirm npm run lint and npm test pass.

The page is served per demo owner: every tenant declared in TENANTS is reachable only at /7d5b6457/<slug> with POST /api/7d5b6457/<slug>/enforcement-requests, and there is no shared or default tenant. Each tenant owns its own court circuit, so change only what the alert's circuit tag names.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the enforcement-request page for the affected tenant in a real browser, submit the default request, and record your screen for the whole attempt so the recording shows the form, the click, and the confirmation with a request number that replaces the previous error panel. Attach a screenshot and an animated webp of the recording to the pull request under a "Fix Verification" heading.`;

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function gatewayTimeoutError(message) {
  const error = new Error(message);
  error.name = 'GatewayTimeoutError';
  error.code = 'INSTRUMENT_VERIFICATION_TIMEOUT';
  error.statusCode = 504;
  return error;
}

function applicantProfile(slug) {
  const tenant = getTenant(slug);
  return tenant ? { ...tenant.applicant } : undefined;
}

function routeTag(tenant) {
  return `/api/7d5b6457/${tenant.slug}/enforcement-requests`;
}

function circuitFor(tenant, instrument) {
  return instrument.issuer === 'court' ? tenant.courtCircuit : instrument.issuer;
}

function verificationEndpointFor(circuit) {
  return VERIFICATION_ROUTES[circuit] || DEFAULT_VERIFICATION_ENDPOINT;
}

function sampleLatency([min, max]) {
  return Math.round(min + Math.random() * (max - min));
}

async function callRegistry(endpoint, instrument, circuit) {
  const spec = REGISTRY_ENDPOINTS[endpoint];
  const latencyMs = sampleLatency(spec.latencyMs);

  if (latencyMs > VERIFICATION_TIMEOUT_MS) {
    await clock.sleep(VERIFICATION_TIMEOUT_MS);
    const error = new Error(`Registry call to ${endpoint} exceeded ${VERIFICATION_TIMEOUT_MS}ms`);
    error.name = 'TimeoutError';
    throw error;
  }

  await clock.sleep(latencyMs);
  return { verified: true, instrumentId: instrument.id, circuit, endpoint, latencyMs };
}

async function verifyInstrument(tenant, instrument) {
  const circuit = circuitFor(tenant, instrument);
  const endpoint = verificationEndpointFor(circuit);

  for (let attempt = 1; attempt <= VERIFICATION_ATTEMPTS; attempt += 1) {
    const started = Date.now();
    try {
      const result = await callRegistry(endpoint, instrument, circuit);
      recordTiming('enforcement.registry.latency', Date.now() - started, { endpoint, circuit });
      return result;
    } catch (error) {
      recordTiming('enforcement.registry.latency', Date.now() - started, { endpoint, circuit, error: 'true' });
      logger.warn('Instrument registry call timed out', {
        service: SERVICE,
        route: routeTag(tenant),
        instrumentId: instrument.id,
        circuit,
        endpoint,
        deprecated: REGISTRY_ENDPOINTS[endpoint].deprecated,
        attempt,
        maxAttempts: VERIFICATION_ATTEMPTS,
        timeoutMs: VERIFICATION_TIMEOUT_MS,
      });
    }
  }

  throw gatewayTimeoutError(
    `Instrument verification timed out after ${VERIFICATION_ATTEMPTS} attempts (${VERIFICATION_TIMEOUT_MS}ms each)`,
  );
}

function parseRequest(data) {
  if (data.acknowledged !== true) {
    throw validationError('Applicant acknowledgement is required', 'ACKNOWLEDGEMENT_REQUIRED');
  }

  const instrument = INSTRUMENTS[String(data.instrumentId || '')];
  if (!instrument) {
    throw validationError('Unknown executive instrument', 'UNKNOWN_INSTRUMENT');
  }

  const requestType = String(data.requestType || '');
  if (!Object.hasOwn(REQUEST_TYPES, requestType)) {
    throw validationError('Unknown enforcement request type', 'UNKNOWN_REQUEST_TYPE');
  }

  const amount = Number(data.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_CLAIM_AMOUNT) {
    throw validationError('Claim amount must be a positive number', 'INVALID_AMOUNT');
  }

  return {
    instrument,
    requestType,
    amount: Math.round(amount * 100) / 100,
    details: String(data.details || '').slice(0, 500),
  };
}

function alertFailure(error, tenant, request, circuit, data) {
  const route = routeTag(tenant);
  const extra = {
    instrumentId: request.instrument.id,
    requestType: request.requestType,
    amount: request.amount,
    circuit,
  };

  Sentry.captureException(error, {
    tags: {
      route,
      service: SERVICE,
      circuit,
      alert_path: 'instant',
    },
    extra,
  });

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
    culprit: 'app/services/verticals/7d5b6457.js — verifyInstrument',
    errorType: error.name || 'Error',
    errorValue: error.message,
    service: SERVICE,
    verticalLabel: tenant.label,
    customer: '7d5b6457',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    promptAppendix: REMEDIATION_DIRECTIVE,
    tags: [
      { key: 'route', value: route },
      { key: 'service', value: SERVICE },
      { key: 'circuit', value: circuit },
      { key: 'http_status', value: String(error.statusCode || 500) },
    ],
    extra,
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
    logger.error('Failed to create Devin session for enforcement-request error', {
      route,
      error: alertError.message,
    });
  });
}

async function submitEnforcementRequest(data) {
  const startTime = Date.now();
  const tenant = getTenant(data.tenant);

  if (!tenant) {
    throw validationError(`Unknown enforcement-request tenant "${data.tenant}"`, 'UNKNOWN_TENANT');
  }

  const request = parseRequest(data);
  const circuit = circuitFor(tenant, request.instrument);
  const route = routeTag(tenant);

  logger.info('Submitting enforcement request', {
    service: SERVICE,
    route,
    instrumentId: request.instrument.id,
    instrumentType: request.instrument.type,
    requestType: request.requestType,
    amount: request.amount,
  });

  try {
    await verifyInstrument(tenant, request.instrument);
    const duration = Date.now() - startTime;

    incrementMetric('enforcement.request.success', { route, requestType: request.requestType });
    recordTiming('enforcement.request.latency', duration, { route });

    return {
      success: true,
      request: {
        requestNumber: `${new Date().getFullYear()}${uuidv4().replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`,
        instrumentLabel: request.instrument.label,
        requestTypeLabel: REQUEST_TYPES[request.requestType],
        amount: request.amount,
        status: 'قيد المراجعة',
        submittedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('enforcement.request.failure', {
      route,
      errorClass: error.name,
      status: String(error.statusCode || 500),
    });
    recordTiming('enforcement.request.latency', duration, { route, error: 'true' });

    logger.error('Enforcement request submission failed', {
      service: SERVICE,
      route,
      instrumentId: request.instrument.id,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
    });

    alertFailure(error, tenant, request, circuit, data);
    throw error;
  }
}

module.exports = {
  submitEnforcementRequest,
  verifyInstrument,
  getTenant,
  applicantProfile,
  TENANTS,
  INSTRUMENTS,
  REQUEST_TYPES,
  REGISTRY_ENDPOINTS,
  VERIFICATION_ROUTES,
  REMEDIATION_DIRECTIVE,
  clock,
};
