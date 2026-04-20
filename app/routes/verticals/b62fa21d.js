const express = require('express');
const { processRewardsLookup, MEMBERS, TIER_BENEFITS } = require('../../services/verticals/b62fa21d');

const router = express.Router();

/**
 * GET /api/b62fa21d/members — returns member list and tier info
 */
router.get('/api/b62fa21d/members', (_req, res) => {
  res.json({ members: MEMBERS, tiers: TIER_BENEFITS });
});

/**
 * POST /api/b62fa21d/rewards — process a rewards balance lookup
 */
router.post('/api/b62fa21d/rewards', async (req, res) => {
  try {
    const result = await processRewardsLookup({
      email: req.body.email || 'alice.chen@example.com',
      memberId: req.body.memberId,
      tier: req.body.tier,
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'MEMBER_NOT_FOUND' ? 404 : 500;
    res.status(statusCode).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'INTERNAL_ERROR',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
