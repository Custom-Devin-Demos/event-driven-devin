const express = require('express');
const { scheduleAppointment, PROVIDERS, PATIENT_PLANS } = require('../../services/verticals/healthcare');

const router = express.Router();

/**
 * GET /api/healthcare/providers — returns provider list
 */
router.get('/api/healthcare/providers', (_req, res) => {
  const patients = Object.entries(PATIENT_PLANS).map(([id, plan]) => ({
    id,
    plan: plan.plan,
    copay: plan.copayAmount,
  }));
  res.json({ providers: PROVIDERS, patients });
});

/**
 * POST /api/healthcare/appointment — schedule an appointment
 */
router.post('/api/healthcare/appointment', async (req, res) => {
  try {
    const result = await scheduleAppointment({
      patientId: req.body.patientId || 'PAT-2001',
      providerId: req.body.providerId || 'DR-101',
      department: req.body.department || 'primary-care',
      appointmentDate: req.body.appointmentDate || '2026-12-15',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'APPOINTMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
