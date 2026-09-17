const express = require('express');
const { reserveDrop, DROP_CATALOG } = require('../../services/verticals/5275ac3e');

const router = express.Router();

router.get('/api/5275ac3e/drops', (_req, res) => {
  res.json({
    drops: Object.entries(DROP_CATALOG).map(([dropId, drop]) => ({
      dropId,
      name: drop.name,
      silhouette: drop.silhouette,
      priceUsd: drop.priceUsd,
      colorway: drop.colorway,
      releaseWindow: drop.releaseWindow,
    })),
  });
});

router.post('/api/5275ac3e/reserve', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await reserveDrop({
      dropId: body.dropId || 'air-series-9',
      size: body.size || 'M 10',
      region: body.region || 'us-west',
      membershipTier: body.membershipTier || 'summit',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'RESERVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
