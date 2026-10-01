const express = require('express');
const {
  activateSavingsCard,
  estimatePharmacyCost,
  PATIENTS,
  MEDICATIONS,
} = require('../../services/verticals/86a0a4f9');

const router = express.Router();

/**
 * GET /api/86a0a4f9/context — synthetic patients and the medication catalog
 */
router.get('/api/86a0a4f9/context', (_req, res) => {
  res.json({
    patients: PATIENTS.map(({ id, name, email, prescribedMedicationId }) => ({ id, name, email, prescribedMedicationId })),
    medications: MEDICATIONS.map(({ id, label, listPrice }) => ({ id, label, listPrice })),
  });
});

/**
 * POST /api/86a0a4f9/savings-card — Lilly Savings Card eligibility check and activation
 */
router.post('/api/86a0a4f9/savings-card', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await activateSavingsCard({
      email: body.email,
      patientId: body.patientId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SAVINGS_CARD_ACTIVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

/**
 * POST /api/86a0a4f9/cost-estimate — what a patient pays at the pharmacy for a monthly fill
 */
router.post('/api/86a0a4f9/cost-estimate', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await estimatePharmacyCost({
      email: body.email,
      patientId: body.patientId,
      medicationId: body.medicationId,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'COST_ESTIMATE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
