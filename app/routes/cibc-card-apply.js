const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const logger = require('../telemetry/logger');
const { incrementMetric } = require('../telemetry/datadog');
const { Sentry } = require('../telemetry/sentry');
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
    address: normaliseAddress({
      street: body.street,
      unit: body.unit,
      city: body.city,
      province: body.province,
      postalCode: body.postalCode,
    }),
  };
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

  try {
    const payload = buildApplicationPayload(body);
    const applicationId = `CC-${uuidv4().slice(0, 8).toUpperCase()}`;

    logger.info('Card application step 1 accepted', {
      applicationId,
      product: payload.product,
      province: payload.address.province,
      service: 'cibc-card-apply',
    });
    incrementMetric('card_application.accepted', { step: '1' });

    return res.json({
      success: true,
      applicationId,
      referenceNumber: applicationId,
      nextStep: { step: 2, label: 'Employment and income' },
      application: payload,
    });
  } catch (error) {
    logger.error('Card application step 1 failed', {
      error: error.message,
      errorClass: error.name,
      stack: error.stack,
      service: 'cibc-card-apply',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/cibc-card-apply/applications',
        service: 'cibc-card-apply',
        step: '1',
      },
      extra: { requestId: req.requestId, province: body.province },
    });

    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      requestId: req.requestId,
    });
  }
});

module.exports = router;
module.exports.validateApplicant = validateApplicant;
module.exports.buildApplicationPayload = buildApplicationPayload;
