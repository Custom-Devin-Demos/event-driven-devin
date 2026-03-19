const express = require('express');
const { processRewardsLookup, MEMBERS, TIER_THRESHOLDS } = require('../../services/verticals/zaxbys');

const router = express.Router();

/**
 * GET /api/zaxbys/menu — returns member list and tier info
 */
router.get('/api/zaxbys/menu', (_req, res) => {
  res.json({ members: MEMBERS, tiers: TIER_THRESHOLDS });
});

/**
 * POST /api/zaxbys/rewards — process a rewards balance lookup
 */
router.post('/api/zaxbys/rewards', async (req, res) => {
  try {
    const result = await processRewardsLookup({
      phone: req.body.phone || '(555) 867-5309',
      lastName: req.body.lastName || 'Johnson',
      location: req.body.location || 'athens-ga',
      userId: req.body.userId || 'usr_zaxbys_1',
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
