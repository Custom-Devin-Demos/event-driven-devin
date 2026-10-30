const express = require('express');
const { startMembership, PLANS } = require('../../services/verticals/ca610f30');
const router = express.Router();

router.post('/api/ca610f30/memberships', async (req, res) => {
  const { planSku = 'premium_uhd_2026', email, devinUserId, devinOrgId, devinEmail } = req.body || {};
  if (typeof planSku !== 'string' || !Object.hasOwn(PLANS, planSku)) {
    return res.status(400).json({ success: false, code: 'INVALID_PLAN', error: 'Choose a valid membership plan.' });
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ success: false, code: 'INVALID_EMAIL', error: 'Enter a valid email address.' });
  }
  try {
    return res.json(await startMembership({ planSku, devinUserId, devinOrgId, devinEmail }));
  } catch (error) {
    return res.status(500).json({ success: false, code: 'MEMBERSHIP_START_FAILED', error: error.message, errorClass: error.name, requestId: req.requestId });
  }
});

module.exports = router;
