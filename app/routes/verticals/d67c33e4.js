const express = require('express');
const { runReplenishment, getNetwork } = require('../../services/verticals/d67c33e4');

const router = express.Router();

router.get('/api/d67c33e4/network', (_req, res) => {
  res.json(getNetwork());
});

router.post('/api/d67c33e4/replenishment', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runReplenishment({
      siteIds: body.siteIds,
      horizonDays: body.horizonDays,
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
      code: error.code || 'REPLENISHMENT_RUN_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
