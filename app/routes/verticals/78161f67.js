const express = require('express');
const { submitApplication, FACILITY_CONFIGS, INTAKE } = require('../../services/verticals/78161f67');

const router = express.Router();

/**
 * GET /api/78161f67/intake — the open intake and its facilities
 */
router.get('/api/78161f67/intake', (_req, res) => {
  const facilities = Object.entries(FACILITY_CONFIGS).map(([id, config]) => ({
    id,
    ...config,
    received: INTAKE.received[id] || 0,
  }));
  res.json({ intake: { id: INTAKE.id, title: INTAKE.title, opensAt: INTAKE.opensAt, closesAt: INTAKE.closesAt }, facilities });
});

/**
 * POST /api/78161f67/apply — submit a nursery admission application
 */
router.post('/api/78161f67/apply', async (req, res) => {
  try {
    const result = await submitApplication({
      facilityId: (req.body.facilityId || 'chuo').trim(),
      applicantName: req.body.applicantName || 'sato_y',
      ageClass: req.body.ageClass || '',
      ward: req.body.ward || '',
      reason: req.body.reason || '',
      note: req.body.note || '',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'APPLICATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
