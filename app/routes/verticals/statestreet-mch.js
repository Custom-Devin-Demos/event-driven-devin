const express = require('express');
const {
  strikeNav,
  releaseNav,
  resetCycle,
  getCycle,
} = require('../../services/verticals/statestreet-mch');

const router = express.Router();

function sendError(res, req, error, fallbackCode) {
  if (error.name === 'ValidationError') {
    return res.status(error.statusCode || 400).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      requestId: error.requestId || req.requestId,
    });
  }
  return res.status(500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: fallbackCode,
    requestId: error.requestId || req.requestId,
  });
}

router.get('/api/statestreet-mch/cycle', (_req, res) => {
  res.json(getCycle());
});

router.post('/api/statestreet-mch/nav/strike', async (req, res) => {
  const body = req.body || {};
  try {
    const result = await strikeNav({
      fundId: body.fundId,
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    sendError(res, req, error, 'NAV_STRIKE_FAILED');
  }
});

router.post('/api/statestreet-mch/nav/release', (req, res) => {
  try {
    res.json(releaseNav({ fundId: (req.body || {}).fundId }));
  } catch (error) {
    sendError(res, req, error, 'NAV_RELEASE_FAILED');
  }
});

router.post('/api/statestreet-mch/sod-reset', (_req, res) => {
  resetCycle();
  res.json({ success: true });
});

module.exports = router;
