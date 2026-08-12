const express = require('express');
const { processInsightsRequest, LOCATION_GROUPS } = require('../../services/verticals/87127748');

const router = express.Router();

router.get('/api/87127748/groups', (_req, res) => {
  res.json({
    groups: Object.entries(LOCATION_GROUPS).map(([group, locations]) => ({
      group,
      locations,
    })),
  });
});

router.post('/api/87127748/insights', async (req, res) => {
  try {
    const result = await processInsightsRequest({
      locationGroup: req.body.locationGroup || 'full-service',
      period: req.body.period || 'last-week',
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
      code: error.code || 'INSIGHTS_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
