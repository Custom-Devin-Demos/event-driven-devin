const express = require('express');
const { runAssessment, NETWORK_REGIONS, INFRA_TIERS } = require('../../services/verticals/430a4200');

const router = express.Router();

/**
 * GET /api/430a4200/network — returns network region data and infra tiers
 */
router.get('/api/430a4200/network', (_req, res) => {
  res.json({ regions: NETWORK_REGIONS, infraTiers: INFRA_TIERS });
});

/**
 * POST /api/430a4200/assess — run a network capacity assessment
 */
router.post('/api/430a4200/assess', async (req, res) => {
  try {
    const result = await runAssessment({
      region: req.body.region || 'north-america',
      subscriberCount: req.body.subscriberCount || 2500,
      infraTier: req.body.infraTier || 'enterprise',
      networkType: req.body.networkType || '5G-SA',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ASSESSMENT_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
