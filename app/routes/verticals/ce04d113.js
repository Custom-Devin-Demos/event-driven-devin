const express = require('express');
const { createAccount, PLAN_TIERS } = require('../../services/verticals/ce04d113');

const router = express.Router();

/**
 * GET /api/ce04d113/plans — self-serve plans offered on the marketing site
 */
router.get('/api/ce04d113/plans', (_req, res) => {
  res.json({
    plans: Object.entries(PLAN_TIERS).map(([code, tier]) => ({
      code,
      label: tier.label,
      basePriceUsd: tier.basePriceUsd,
      perPersonUsd: tier.perPersonUsd,
    })),
  });
});

/**
 * POST /api/ce04d113/create-account — create a self-serve account
 */
router.post('/api/ce04d113/create-account', async (req, res) => {
  try {
    const body = req.body || {};
    const account = await createAccount({
      plan: body.plan || 'simple',
      companyName: body.companyName || 'Mason\u2019s Creamery',
      primaryState: body.primaryState || 'MN',
      employeeCount: body.employeeCount || 6,
      payFrequency: body.payFrequency || 'biweekly',
      devinUserId: body.devinUserId,
      devinOrgId: body.devinOrgId,
      devinEmail: body.devinEmail,
    });
    res.json(account);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      errorClass: error.name,
      code: error.code || 'ACCOUNT_SETUP_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
