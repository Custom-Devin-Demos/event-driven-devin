const express = require('express');
const { runAssessment, REGIONS, SUBSTATIONS } = require('../../services/verticals/dominion-energy');

const router = express.Router();

/**
 * GET /api/dominion-energy/grid — returns grid data
 */
router.get('/api/dominion-energy/grid', (_req, res) => {
  res.json({ regions: REGIONS, substations: SUBSTATIONS });
});

/**
 * POST /api/dominion-energy/assess — run a grid reliability assessment
 */
router.post('/api/dominion-energy/assess', async (req, res) => {
  try {
    const result = await runAssessment({
      region: req.body.region || 'NOVA',
      assessType: req.body.assessType || 'reliability',
      priority: req.body.priority || 'standard',
      incidentRef: req.body.incidentRef,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ASSESSMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
