const express = require('express');
const { provisionLicense, SUBSCRIPTIONS, PLAN_CONFIGS } = require('../../services/verticals/hightech');

const router = express.Router();

/**
 * GET /api/licenses/subscriptions — returns active subscriptions
 */
router.get('/api/licenses/subscriptions', (_req, res) => {
  const plans = Object.entries(PLAN_CONFIGS).map(([name, config]) => ({
    name,
    ...config,
  }));
  res.json({
    subscriptions: SUBSCRIPTIONS,
    availablePlans: plans,
  });
});

/**
 * POST /api/licenses/provision — provision a new license
 */
router.post('/api/licenses/provision', async (req, res) => {
  try {
    const planName = (req.body.planName || 'Professional').trim();
    const result = await provisionLicense({
      orgName: req.body.orgName || 'New Customer Inc',
      planName,
      seats: parseInt(req.body.seats, 10) || 10,
      billingCycle: req.body.billingCycle || 'monthly',
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
      code: error.code || 'PROVISION_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
