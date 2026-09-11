const express = require('express');
const {
  submitEnrollment,
  estimateCopay,
  PATIENTS,
  THERAPIES,
} = require('../../services/verticals/fcf0f903');

const router = express.Router();

/**
 * GET /api/fcf0f903/context — enrolled patient records and supported therapies
 */
router.get('/api/fcf0f903/context', (_req, res) => {
  res.json({
    patients: PATIENTS.map(({ id, name, dateOfBirth, prescriber, coverage }) => ({
      id, name, dateOfBirth, prescriber, plan: coverage.plan,
    })),
    therapies: THERAPIES,
  });
});

/**
 * POST /api/fcf0f903/enrollment — enroll a patient in copay assistance
 */
router.post('/api/fcf0f903/enrollment', async (req, res) => {
  try {
    const confirmation = await submitEnrollment({
      patientId: req.body.patientId,
      therapyId: req.body.therapyId,
      consent: req.body.consent,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(confirmation);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ENROLLMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/fcf0f903/copay-estimate — quote the patient's expected copay
 */
router.post('/api/fcf0f903/copay-estimate', async (req, res) => {
  try {
    const estimate = await estimateCopay({
      patientId: req.body.patientId,
      therapyId: req.body.therapyId,
      fills: req.body.fills,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(estimate);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'COPAY_ESTIMATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
