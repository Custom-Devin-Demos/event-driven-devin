const express = require('express');
const { upgradePlan, PLANS, ACCOUNTS } = require('../../services/verticals/telco');

const router = express.Router();

/**
 * GET /api/telco/plans — returns plans and customer accounts
 */
router.get('/api/telco/plans', (_req, res) => {
  res.json({ plans: PLANS, accounts: ACCOUNTS });
});

/**
 * POST /api/telco/upgrade — upgrade a customer's plan
 */
router.post('/api/telco/upgrade', async (req, res) => {
  try {
    const result = await upgradePlan({
      accountId: req.body.accountId || 'CUST-3001',
      currentPlanCode: req.body.currentPlanCode || 'basic-12',
      targetPlanCode: req.body.targetPlanCode || 'family-plus-12',
      billingDay: req.body.billingDay || 15,
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
      code: error.code || 'UPGRADE_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
