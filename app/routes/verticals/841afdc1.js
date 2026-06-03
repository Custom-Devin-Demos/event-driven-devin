const express = require('express');
const { processAccountSummary, ACCOUNTS } = require('../../services/verticals/841afdc1');

const router = express.Router();

/**
 * GET /api/841afdc1/accounts — returns the customer's finance accounts
 */
router.get('/api/841afdc1/accounts', (_req, res) => {
  res.json({
    accounts: ACCOUNTS.map((a) => ({
      id: a.id,
      productType: a.productType,
      vehicle: `${a.vehicle.year} Ford ${a.vehicle.model}`,
    })),
  });
});

/**
 * POST /api/841afdc1/account-summary — build the dashboard account summary
 */
router.post('/api/841afdc1/account-summary', async (req, res) => {
  try {
    const result = await processAccountSummary({
      accountId: req.body.accountId || 'LSE-2208314',
      productType: req.body.productType || 'red_carpet_lease',
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
      code: error.code || 'ACCOUNT_SUMMARY_FAILED',
      requestId: req.requestId,
    });
  }
});

module.exports = router;
