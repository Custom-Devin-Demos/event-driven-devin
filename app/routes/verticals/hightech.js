const express = require('express');
const { provisionLicense, SUBSCRIPTIONS, VALID_PLANS, PLAN_CONFIGS } = require('../../services/verticals/hightech');

const router = express.Router();

/**
 * GET /api/licenses/subscriptions — returns active subscriptions
 */
router.get('/api/licenses/subscriptions', (_req, res) => {
  res.json({
    subscriptions: SUBSCRIPTIONS,
    availablePlans: VALID_PLANS.map((name, idx) => ({
      name,
      ...PLAN_CONFIGS[idx],
    })),
  });
});

/**
 * POST /api/licenses/provision — provision a new license
 */
router.post('/api/licenses/provision', async (req, res) => {
  try {
    const result = await provisionLicense({
      orgName: req.body.orgName || 'New Customer Inc',
      planName: req.body.planName || 'professional',
      seats: req.body.seats || 10,
      billingCycle: req.body.billingCycle || 'monthly',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'PROVISION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
