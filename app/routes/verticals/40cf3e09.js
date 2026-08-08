const express = require('express');
const {
  processAccountActivation,
  ACCOUNT_REGIONS,
  TIER_TERMS,
} = require('../../services/verticals/40cf3e09');

const router = express.Router();

/**
 * GET /api/40cf3e09/plans — returns available regions and plan tiers
 */
router.get('/api/40cf3e09/plans', (_req, res) => {
  res.json({
    regions: Object.entries(ACCOUNT_REGIONS).map(([id, r]) => ({
      id,
      region: r.region,
      zone: r.zone,
    })),
    planTiers: Object.entries(TIER_TERMS).map(([id, t]) => ({
      id,
      baseCredits: t.baseCredits,
      bonusCredits: t.bonusCredits,
      windowMonths: t.windowMonths,
    })),
  });
});

/**
 * POST /api/40cf3e09/activate — activate a new account and grant credits
 */
router.post('/api/40cf3e09/activate', async (req, res) => {
  try {
    const result = await processAccountActivation({
      region: req.body.region || 'us-east-1',
      planTier: req.body.planTier || 'free',
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
      code: error.code || 'ACCOUNT_ACTIVATION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
