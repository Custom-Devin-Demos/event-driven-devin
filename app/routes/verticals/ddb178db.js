const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { listProducts, signIn } = require('../../services/verticals/ddb178db');

const router = express.Router();

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function sendError(res, req, error, fallbackCode) {
  res.status(error.statusCode || 500).json({
    success: false,
    error: error.message,
    errorClass: error.name,
    code: error.code || fallbackCode,
    requestId: error.requestId || req.requestId,
  });
}

router.get('/api/ddb178db/card-offers', (_req, res) => {
  res.json({ success: true, offers: listProducts() });
});

router.post('/api/ddb178db/sessions', verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await signIn({
      onlineId: text(body.onlineId, 64),
      deviceId: text(body.deviceId, 64) || undefined,
      rememberId: body.rememberId === true,
      devinUserId: text(body.devinUserId, 128) || undefined,
      devinOrgId: text(body.devinOrgId, 128) || undefined,
      devinEmail: text(body.devinEmail, 254) || undefined,
    });
    res.json({ success: true, result });
  } catch (error) {
    sendError(res, req, error, 'OLB_SIGNIN_FAILED');
  }
});

module.exports = router;
