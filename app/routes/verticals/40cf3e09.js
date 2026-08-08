const express = require('express');
const { processAccountActivation, REGION_PARTITIONS } = require('../../services/verticals/40cf3e09');

const router = express.Router();

router.get('/api/40cf3e09/regions', (_req, res) => {
  res.json({
    regions: Object.entries(REGION_PARTITIONS).map(([region, meta]) => ({
      region,
      geo: meta.geo,
    })),
  });
});

router.post('/api/40cf3e09/activate', async (req, res) => {
  try {
    const result = await processAccountActivation({
      planTier: req.body.planTier || 'free',
      region: req.body.region || 'us-east-1',
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
      code: error.code || 'ACTIVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
