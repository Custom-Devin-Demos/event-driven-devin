const express = require('express');
const { runAssessment, NETWORK_REGIONS, INFRA_TIERS, NETWORK_TYPES } = require('../../services/verticals/430a4200');

const router = express.Router();

/**
 * GET /api/430a4200/config — returns available network configuration options
 */
router.get('/api/430a4200/config', (_req, res) => {
  res.json({
    regions: Object.keys(NETWORK_REGIONS),
    infraTiers: Object.keys(INFRA_TIERS),
    networkTypes: Object.keys(NETWORK_TYPES),
  });
});

/**
 * POST /api/430a4200/assess — run a network performance assessment
 */
router.post('/api/430a4200/assess', async (req, res) => {
  try {
    const result = await runAssessment({
      networkRegion: req.body.networkRegion || 'north-america',
      networkType: req.body.networkType || '5G-SA',
      subscriberCount: req.body.subscriberCount || 2500,
      targetUptime: req.body.targetUptime || 99.95,
      infraTier: req.body.infraTier || 'enterprise',
      userId: req.body.userId || 'usr_430a4200_1',
      devinUserId: req.body.devinUserId,
      devinOrgId: req.body.devinOrgId,
      devinEmail: req.body.devinEmail,
    });
    res.json(result);
  } catch (error) {
    const statusCode = error.code === 'INVALID_REGION' ? 422 : 500;
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
