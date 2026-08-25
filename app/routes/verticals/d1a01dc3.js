const express = require('express');
const { scheduleVisit, VISIT_TYPES } = require('../../services/verticals/d1a01dc3');

const router = express.Router();

/**
 * GET /api/d1a01dc3/visit-types — visit types bookable in MyBSWHealth
 */
router.get('/api/d1a01dc3/visit-types', (_req, res) => {
  res.json({
    visitTypes: VISIT_TYPES.map((type) => ({
      code: type.code,
      name: type.name,
      description: type.description,
    })),
  });
});

/**
 * POST /api/d1a01dc3/schedule-visit — book a MyBSWHealth appointment
 */
router.post('/api/d1a01dc3/schedule-visit', async (req, res) => {
  try {
    const result = await scheduleVisit({
      visitType: req.body.visitType || 'video-visit',
      insurancePlan: req.body.insurancePlan || 'bswhp-ppo',
      patientMrn: req.body.patientMrn,
      requestedStart: req.body.requestedStart,
      providerName: req.body.providerName,
      location: req.body.location,
      reasonForVisit: req.body.reasonForVisit,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'APPOINTMENT_SCHEDULING_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
