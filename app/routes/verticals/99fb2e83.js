const express = require('express');
const { verifySessionSecret } = require('../../middleware/verify-session-secret');
const { startSignIn, ROUTE } = require('../../services/verticals/99fb2e83');

const router = express.Router();

const ENTRY_POINTS = ['account-menu', 'hero'];
const LOCALES = ['en_US', 'en_GB', 'fr_FR'];

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function orgId(value) {
  const candidate = text(value, 128);
  return /^org[-_][A-Za-z0-9]+$/.test(candidate) ? candidate : undefined;
}

function oneOf(value, allowed, fallback) {
  const candidate = text(value, 40);
  return allowed.includes(candidate) ? candidate : fallback;
}

router.post(ROUTE, verifySessionSecret, async (req, res) => {
  const body = req.body || {};
  try {
    const result = await startSignIn({
      entryPoint: oneOf(body.entryPoint, ENTRY_POINTS, 'account-menu'),
      locale: oneOf(body.locale, LOCALES, 'en_US'),
      deviceId: /^web-[a-f0-9]{8}$/.test(text(body.deviceId, 16)) ? text(body.deviceId, 16) : undefined,
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
      code: error.code || 'PLAYER_SIGNIN_FAILED',
      requestId: error.requestId || req.requestId,
    });
  }
});

module.exports = router;
