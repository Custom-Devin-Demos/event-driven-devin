const express = require('express');
const { getBoard, previewAllocation, releaseWave } = require('../../services/verticals/fb76423f');

const router = express.Router();

// Reproduction mode lets an engineer fail a release locally without raising an
// alert. It is ignored in production.
function isReproductionRequest(req) {
  return Boolean(req.headers['x-synthetic']) && process.env.NODE_ENV !== 'production';
}

function sendHandledError(res, req, error) {
  return res.status(error.statusCode).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code,
    requestId: error.requestId || req.requestId,
  });
}

router.get('/api/fb76423f/board', (_req, res) => {
  res.json(getBoard());
});

router.post('/api/fb76423f/waves/:waveId/preview', (req, res) => {
  try {
    res.json(previewAllocation(req.params.waveId));
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) return sendHandledError(res, req, error);
    return res.status(500).json({ success: false, error: error.message, errorClass: error.name, code: 'PREVIEW_FAILED', requestId: req.requestId });
  }
});

router.post('/api/fb76423f/waves/:waveId/release', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await releaseWave({
      waveId: req.params.waveId,
      confirmed: body.confirmed,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
      synthetic: isReproductionRequest(req),
    });
    res.json(result);
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) return sendHandledError(res, req, error);
    return res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: 'WAVE_RELEASE_FAILED',
      requestId: error.requestId || req.requestId,
      impact: error.impact || null,
    });
  }
});

module.exports = router;
