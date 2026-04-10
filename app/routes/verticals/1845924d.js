const express = require('express');
const { runAssessment, REGIONS, SUBSTATIONS } = require('../../services/verticals/1845924d');

const router = express.Router();

/**
 * GET /api/1845924d/grid — returns grid data
 */
router.get('/api/1845924d/grid', (_req, res) => {
  res.json({ regions: REGIONS, substations: SUBSTATIONS });
});

/**
 * POST /api/1845924d/assess — run a grid reliability assessment
 */
router.post('/api/1845924d/assess', async (req, res) => {
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
