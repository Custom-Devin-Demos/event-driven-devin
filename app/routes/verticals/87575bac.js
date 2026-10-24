const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { getBlotter, getTrade, releaseInstructions } = require('../../services/verticals/87575bac');

const router = express.Router();

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function sendError(res, req, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    status: error.tradeStatus,
    requestId: error.requestId || req.requestId,
  });
}

router.get('/api/87575bac/trades', (_req, res) => {
  res.json({ success: true, ...getBlotter() });
});

router.get('/api/87575bac/trades/:tradeId', (req, res) => {
  try {
    res.json({ success: true, trade: getTrade(text(req.params.tradeId, 40)) });
  } catch (error) {
    sendError(res, req, error, 'TRADE_LOOKUP_FAILED');
  }
});

router.post('/api/87575bac/trades/:tradeId/release', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await releaseInstructions({
      tradeId: text(req.params.tradeId, 40),
      devinUserId: text(body.devinUserId, 128) || undefined,
      devinOrgId: text(body.devinOrgId, 128) || undefined,
      devinEmail: text(body.devinEmail, 254) || undefined,
    });
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, req, error, 'SSI_RELEASE_FAILED');
  }
});

module.exports = router;
