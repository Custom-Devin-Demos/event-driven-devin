const express = require('express');
const {
  runSurveillanceSweep,
  DESKS,
  LOOKBACK_WINDOWS,
  CHANNEL_SCOPES,
} = require('../../services/verticals/4ea2d7f6');

const router = express.Router();

router.get('/api/4ea2d7f6/options', (req, res) => {
  res.json({
    desks: Object.entries(DESKS).map(([key, desk]) => ({ key, label: desk.label })),
    scopes: Object.entries(CHANNEL_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      channelCount: scope.channels.length,
    })),
    lookbacks: Object.entries(LOOKBACK_WINDOWS).map(([key, lookback]) => ({ key, label: lookback.label })),
  });
});

router.post('/api/4ea2d7f6/surveillance-sweep', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await runSurveillanceSweep({
      desk: body.desk,
      scope: body.scope,
      lookback: body.lookback,
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
      code: error.code || 'SURVEILLANCE_SWEEP_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
