const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { startAccountSession, ROUTE } = require('../../services/verticals/ea99f141');

const router = express.Router();

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function orgId(value) {
  const candidate = text(value, 128);
  return /^org[-_][A-Za-z0-9]+$/.test(candidate) ? candidate : undefined;
}

router.post(ROUTE, verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await startAccountSession({
      entryPoint: text(body.entryPoint, 40) || 'internet-hero',
      deviceId: text(body.deviceId, 64) || undefined,
      serviceZip: text(body.serviceZip, 10) || undefined,
      devinUserId: text(body.devinUserId, 128) || undefined,
      devinOrgId: orgId(body.devinOrgId),
      devinEmail: text(body.devinEmail, 254) || undefined,
    });
    res.json({ success: true, result });
  } catch (error) {
    res.status(error.statusCode || 500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ACCOUNT_SIGNIN_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
