const express = require('express');
const { processRewardsLookup, MEMBERS, TIER_THRESHOLDS } = require('../../services/verticals/ef5d1dc1');

const router = express.Router();

/**
 * GET /api/ef5d1dc1/menu — returns member list and tier info
 */
router.get('/api/ef5d1dc1/menu', (_req, res) => {
  res.json({ members: MEMBERS, tiers: TIER_THRESHOLDS });
});

/**
 * POST /api/ef5d1dc1/rewards — process a rewards balance lookup
 */
router.post('/api/ef5d1dc1/rewards', async (req, res) => {
  try {
    const result = await processRewardsLookup({
      phone: req.body.phone || '(555) 867-5309',
      lastName: req.body.lastName || 'Johnson',
      location: req.body.location || 'athens-ga',
      userId: req.body.userId || 'usr_zaxbys_1',
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
