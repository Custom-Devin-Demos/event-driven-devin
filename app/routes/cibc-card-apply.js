const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const logger = require('../telemetry/logger');
const { incrementMetric } = require('../telemetry/datadog');
const { Sentry } = require('../telemetry/sentry');
const { createSessionAndAlert } = require('../services/devin-session');
const {
  normaliseAddress,
  isValidPostalCode,
  PROVINCES,
  PROVINCE_CODES,
} = require('../../src/application/addressNormaliser');

const router = express.Router();

const REQUIRED_FIELDS = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['dateOfBirth', 'Date of birth'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['street', 'Street address'],
  ['city', 'City'],
  ['province', 'Province'],
  ['postalCode', 'Postal code'],
];

const ADDRESS_FIELDS = ['street', 'unit', 'city', 'province', 'postalCode'];

const FUNNEL_DIRECTIVE = [
  'Step 1 of the CIBC card application funnel at /cibc-card-apply-demo fails for a subset of',
  'applicants. Reproduce by POSTing a valid application to',
  'POST /api/cibc-card-apply/applications and compare a submission that includes an Apt / Unit',
  'value against one that omits it — the Apt / Unit field is optional on the form, so the address',
  'normaliser must handle its absence. Fix the normalisation path rather than the route, add',
  'regression coverage for the failing input, and verify the form reaches the confirmation panel',
  'end-to-end on /cibc-card-apply-demo.',
].join(' ');

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * Validate the step-1 applicant form. Returns a map of field -> message.
 */
function validateApplicant(body) {
  const errors = {};

  REQUIRED_FIELDS.forEach(([field, label]) => {
    if (isBlank(body[field])) {
      errors[field] = `${label} is required`;
    }
  });

  if (!errors.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(body.email).trim())) {
    errors.email = 'Enter a valid email address';
  }

  if (!errors.province && !PROVINCE_CODES.includes(String(body.province).trim().toUpperCase())) {
    errors.province = 'Select a province or territory';
  }

  if (!errors.postalCode && !isValidPostalCode(body.postalCode)) {
    errors.postalCode = 'Enter a valid postal code (A1A 1A1)';
  }

  return errors;
}

/**
 * Collect the address fields the applicant actually supplied.
 */
function addressInput(body) {
  const input = {};

  ADDRESS_FIELDS.forEach((field) => {
    if (!isBlank(body[field])) {
      input[field] = body[field];
    }
  });

  return input;
}

/**
 * Build the application payload posted to the applications endpoint.
 */
function buildApplicationPayload(body) {
  return {
    product: body.product || 'cibc-dividend-visa-infinite',
    step: 1,
    applicant: {
      firstName: String(body.firstName).trim(),
      lastName: String(body.lastName).trim(),
      dateOfBirth: String(body.dateOfBirth).trim(),
      email: String(body.email).trim().toLowerCase(),
      phone: String(body.phone).replace(/[^\d]/g, ''),
    },
    address: normaliseAddress(addressInput(body)),
  };
}

/**
 * Report a failed submission to Sentry/Datadog and open a Devin investigation.
 */
function reportSubmitFailure(error, body, requestId) {
  incrementMetric('card_application.failure', {
    route: '/api/cibc-card-apply/applications',
    errorClass: error.name,
  });

  logger.error('Card application step 1 failed', {
    error: error.message,
    errorClass: error.name,
    stack: error.stack,
    province: body.province,
    service: 'cibc-card-apply',
  });

  Sentry.captureException(error, {
    tags: {
      route: '/api/cibc-card-apply/applications',
      service: 'cibc-card-apply',
      step: '1',
      page: '/cibc-card-apply-demo',
    },
    extra: { requestId, province: body.province },
  });

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'src/application/addressNormaliser.js — normaliseAddress',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: body.devinUserId,
    devinEmail: body.devinEmail,
    devinOrgId: body.devinOrgId,
    service: 'cibc-card-apply',
    verticalLabel: 'CIBC Card Application',
    tags: [
      { key: 'route', value: '/api/cibc-card-apply/applications' },
      { key: 'service', value: 'cibc-card-apply' },
      { key: 'step', value: '1' },
      { key: 'page', value: '/cibc-card-apply-demo' },
    ],
    promptAppendix: FUNNEL_DIRECTIVE,
    extra: { requestId, province: body.province },
    level: 'error',
    platform: 'node',
    lastSeen: new Date().toISOString(),
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'cibc-card-apply@1.0.0',
    environment: process.env.DD_ENV || 'prod',
  }).catch((err) => {
    logger.error('Failed to trigger Devin session from card application error', {
      error: err.message,
    });
  });
}

/**
 * Normalise the submitted form, record the application and answer the client.
 */
async function recordApplication(body, res) {
  const payload = buildApplicationPayload(body);
  const applicationId = `CC-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Card application step 1 accepted', {
    applicationId,
    product: payload.product,
    province: payload.address.province,
    service: 'cibc-card-apply',
  });
  incrementMetric('card_application.accepted', { step: '1' });

  res.json({
    success: true,
    applicationId,
    referenceNumber: applicationId,
    nextStep: { step: 2, label: 'Employment and income' },
    application: payload,
  });
}

/**
 * GET /cibc-card-apply-demo — step 1 of the card application funnel
 */
router.get('/cibc-card-apply-demo', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/cibc-card-apply-demo.html'));
});

/**
 * GET /api/cibc-card-apply/provinces — province list for the select
 */
router.get('/api/cibc-card-apply/provinces', (_req, res) => {
  res.json({ provinces: PROVINCES });
});

/**
 * POST /api/cibc-card-apply/applications — stub submit endpoint
 */
router.post('/api/cibc-card-apply/applications', (req, res) => {
  const body = req.body || {};
  const errors = validateApplicant(body);

  if (Object.keys(errors).length > 0) {
    incrementMetric('card_application.rejected', { step: '1', reason: 'validation' });
    return res.status(400).json({ success: false, errors });
  }

  recordApplication(body, res).catch((error) => {
    reportSubmitFailure(error, body, req.requestId);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: 'We could not process your application. Our team has been notified.',
        errorClass: error.name,
        requestId: req.requestId,
      });
    }
  });
});

module.exports = router;
module.exports.validateApplicant = validateApplicant;
module.exports.buildApplicationPayload = buildApplicationPayload;
