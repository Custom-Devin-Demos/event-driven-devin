const express = require('express');
const { processKeyMetricsRequest, MARKETS } = require('../../services/verticals/bec5e1bb');

const router = express.Router();

router.get('/api/bec5e1bb/markets', (_req, res) => {
  res.json({
    markets: Object.entries(MARKETS).map(([code, market]) => ({
      code,
      name: market.name,
      accesses: market.accesses,
    })),
  });
});

router.post('/api/bec5e1bb/metrics', async (req, res) => {
  try {
    const result = await processKeyMetricsRequest({
      regions: req.body.regions,
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
      code: error.code || 'KEY_METRICS_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
