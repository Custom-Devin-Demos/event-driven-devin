const express = require('express');
const { processSignup, REGIONS, PLANS } = require('../../services/verticals/99a8ba1a');

const router = express.Router();

/**
 * GET /api/99a8ba1a/components — returns region and plan data
 */
router.get('/api/99a8ba1a/components', (_req, res) => {
  res.json({ regions: REGIONS, plans: PLANS });
});

/**
 * POST /api/99a8ba1a/signup — process a rider signup
 */
router.post('/api/99a8ba1a/signup', async (req, res) => {
  try {
    const result = await processSignup({
      plan: req.body.plan || 'rider',
      region: req.body.region || 'us-west',
      referralCode: req.body.referralCode,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'SIGNUP_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
