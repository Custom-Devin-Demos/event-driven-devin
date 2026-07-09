const express = require('express');
const { processSubscription, PLANS } = require('../../services/verticals/b634a963');

const router = express.Router();

/**
 * GET /api/b634a963/plans — returns available subscription plans
 */
router.get('/api/b634a963/plans', (_req, res) => {
  res.json({
    plans: Object.entries(PLANS).map(([id, p]) => ({
      id,
      code: p.code,
      monthly: p.monthly,
      apps: p.apps,
      storageGb: p.storageGb,
    })),
  });
});

/**
 * POST /api/b634a963/subscribe — place a subscription order
 */
router.post('/api/b634a963/subscribe', async (req, res) => {
  try {
    const result = await processSubscription({
      plan: req.body.plan || 'all_apps',
      billingCycle: req.body.billingCycle || 'monthly',
      seats: req.body.seats || 1,
      addons: req.body.addons || [],
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
      code: error.code || 'SUBSCRIPTION_ORDER_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
